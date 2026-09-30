// Local test for the batch-credential exchange: drives complete exchanges
// in-process with mocked DynamoDB/S3/KMS, a stubbed templates API, and a real
// wallet-side did:key signing the DIDAuth presentations.
//
//   cd src/batch-exchange && npm install && npm test
process.env.TABLE_NAME = "exchanges-test";
process.env.BUNDLES_TABLE_NAME = "bundles-test";
process.env.TEMPLATES_API_BASE = "https://templates.example.com/Prod";

import { randomUUID, randomBytes } from "node:crypto";
import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    UpdateItemCommand,
    ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { mockClient } from "aws-sdk-client-mock";
import * as vc from "@digitalbazaar/vc";
import { Ed25519Signature2020 } from "@digitalbazaar/ed25519-signature-2020";
import { Ed25519VerificationKey2020 } from "@digitalbazaar/ed25519-verification-key-2020";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";

const { lambdaHandler } = await import("../app.mjs");
const { documentLoader, suiteFromSeed } = await import("../issue.mjs");

// ---- fixture: what the notify lambda staged

const SPACE_URL = "https://was.lcw-sandbox.org/space/dcc-was-11111111-2222-3333-4444-555555555555";
const BUCKET = "dcc-was-11111111-2222-3333-4444-555555555555";
const CRED_ID = randomUUID();
const CTX = randomUUID();
const seedBytes = randomBytes(32);
const SEED = seedBytes.toString("hex");
const batchKey = await Ed25519VerificationKey2020.generate({ seed: new Uint8Array(seedBytes) });
const BATCH_DID = `did:key:${batchKey.fingerprint()}`;

const BUNDLE = {
    credId: CRED_ID,
    batchName: "VC Summit 2026 attendance",
    templateId: "conference",
    issuer: { name: "VC Summit", url: "https://summit.example.org" },
    fields: { recipientName: "Ada Lovelace", conferenceName: "VC Summit 2026" },
    seed: SEED,
    did: BATCH_DID,
};

// A fake KMS: "ciphertext" is the plaintext plus the encryption context that
// was bound at encryption time; Decrypt only succeeds when the caller's
// context matches, as real KMS enforces.
const boundContext = { credId: CRED_ID, context: CTX };
const ciphertext = Buffer.from(JSON.stringify({ plaintext: JSON.stringify(BUNDLE), boundContext }));

const kmsMock = mockClient(KMSClient);
kmsMock.on(DecryptCommand).callsFake(({ CiphertextBlob, EncryptionContext }) => {
    const { plaintext, boundContext: bound } = JSON.parse(Buffer.from(CiphertextBlob).toString());
    if (bound.credId !== EncryptionContext?.credId || bound.context !== EncryptionContext?.context) {
        const err = new Error("InvalidCiphertextException");
        err.name = "InvalidCiphertextException";
        throw err;
    }
    return { Plaintext: Buffer.from(plaintext) };
});

// In-memory batch bucket holding the staged bundle, plus a log entry written
// before collection histories existed (bare collectedAt, no collections
// array) to prove the fold-in.
const LEGACY_COLLECTED_AT = "2026-01-01T00:00:00.000Z";
const objects = new Map([
    [`collections/${CRED_ID}/bundle.json`, JSON.stringify({ keyId: "k", ciphertext: ciphertext.toString("base64") })],
    ["collections/logs/log.json", JSON.stringify({
        entries: [{ type: "notification-triggered", at: LEGACY_COLLECTED_AT, recipientCount: 1 }],
        credentials: { [CRED_ID]: { emailSentAt: LEGACY_COLLECTED_AT, collectedAt: LEGACY_COLLECTED_AT } },
    })],
]);
const s3Mock = mockClient(S3Client);
s3Mock.on(GetObjectCommand).callsFake(({ Key }) => {
    if (!objects.has(Key)) {
        const err = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        throw err;
    }
    return { Body: { transformToString: async () => objects.get(Key) } };
});
s3Mock.on(PutObjectCommand).callsFake(({ Key, Body }) => {
    objects.set(Key, Body);
    return {};
});

// In-memory exchanges + bundles tables, honoring the conditional update.
const exchanges = new Map();
const ddb = mockClient(DynamoDBClient);
ddb.on(GetItemCommand).callsFake(({ TableName, Key }) => {
    if (TableName === "bundles-test") {
        return Key.credId.S === CRED_ID
            ? { Item: { credId: { S: CRED_ID }, spaceUrl: { S: SPACE_URL } } }
            : {};
    }
    return { Item: exchanges.get(Key.exchangeId.S) };
});
ddb.on(PutItemCommand).callsFake(({ Item }) => {
    exchanges.set(Item.exchangeId.S, Item);
    return {};
});
ddb.on(UpdateItemCommand).callsFake(({ Key, ExpressionAttributeValues }) => {
    const item = exchanges.get(Key.exchangeId.S);
    if (item.state.S !== ExpressionAttributeValues[":pending"].S) {
        throw new ConditionalCheckFailedException({ message: "conditional", $metadata: {} });
    }
    item.state = ExpressionAttributeValues[":complete"];
    item.result = ExpressionAttributeValues[":result"];
    return {};
});

// The templates API, stubbed: echoes a populated unsigned VC the way
// credential-templates builds one.
let templateCalls = 0;
globalThis.fetch = async (url, { body } = {}) => {
    templateCalls++;
    const { issuer, fields } = JSON.parse(body);
    if (!String(url).includes("/templates/conference")) {
        return { ok: false, status: 404, text: async () => "no such template" };
    }
    return {
        ok: true,
        status: 200,
        json: async () => ({
            "@context": ["https://www.w3.org/ns/credentials/v2"],
            type: ["VerifiableCredential", "ConferenceAttendanceCredential"],
            name: `${fields.conferenceName} Attendance`,
            issuer: { id: issuer.url, type: ["Profile"], name: issuer.name },
            credentialSubject: {
                type: ["Person"],
                name: fields.recipientName,
                attendedEvent: { type: ["Event"], name: fields.conferenceName },
            },
            validFrom: new Date().toISOString(),
        }),
    };
};

const event = ({ exchangeId, query, body, method = "POST" } = {}) => ({
    pathParameters: { workflowId: "batch-credential", ...(exchangeId && { exchangeId }) },
    rawPath: `/workflows/batch-credential/exchanges${exchangeId ? `/${exchangeId}` : ""}`,
    queryStringParameters: query,
    headers: { host: "issuer.example.com", "x-forwarded-proto": "https" },
    requestContext: { http: { method } },
    isBase64Encoded: false,
    body: body ?? null,
});

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
    if (!ok) failures++;
}

// 0. the two key libraries derive the same did:key from the same seed (the
// bundle's did comes from @interop, signing uses @digitalbazaar)
{
    const interopKey = await Ed25519VerificationKey.generate({ seed: new Uint8Array(seedBytes) });
    check("cross-library did:key derivation matches",
        `did:key:${interopKey.fingerprint()}` === BATCH_DID, BATCH_DID);
}

// 1. create validation
let res = await lambdaHandler(event({ body: JSON.stringify({}) }));
check("create without credId/ctx -> 400", res.statusCode === 400);
res = await lambdaHandler(event({ body: JSON.stringify({ credId: randomUUID(), ctx: CTX }) }));
check("create with unknown credId -> 404", res.statusCode === 404);

// 2. create embeds ctx in the exchange URL and stores no ctx
res = await lambdaHandler(event({ body: JSON.stringify({ credId: CRED_ID, ctx: CTX }) }));
const created = JSON.parse(res.body);
check("create -> 201", res.statusCode === 201, res.body.slice(0, 120));
check("id and both serviceEndpoints carry ?ctx=",
    created.id.endsWith(`?ctx=${CTX}`) &&
    created.verifiablePresentationRequest.interact.service.every(
        ({ serviceEndpoint }) => serviceEndpoint === created.id));
check("exchange row stores credId but no ctx", (() => {
    const row = exchanges.get(created.exchangeId);
    return row.credId.S === CRED_ID && !JSON.stringify(row).includes(CTX);
})());

// 3. the wallet side
const holderKey = await Ed25519VerificationKey2020.generate();
const holderDid = `did:key:${holderKey.fingerprint()}`;
holderKey.controller = holderDid;
holderKey.id = `${holderDid}#${holderKey.fingerprint()}`;
const signVp = (challenge, domain) => vc.signPresentation({
    presentation: vc.createPresentation({ holder: holderDid }),
    suite: new Ed25519Signature2020({ key: holderKey }),
    challenge,
    ...(domain && { domain }),
    documentLoader,
});
const vpr = created.verifiablePresentationRequest;

// 4. empty participate -> DIDAuth request
res = await lambdaHandler(event({ exchangeId: created.exchangeId, query: { ctx: CTX }, body: "" }));
check("empty POST -> DIDAuthentication request", res.statusCode === 200 &&
    JSON.parse(res.body).verifiablePresentationRequest.challenge === vpr.challenge);

// 5. wrong ctx cannot decrypt
res = await lambdaHandler(event({
    exchangeId: created.exchangeId,
    query: { ctx: randomUUID() },
    body: JSON.stringify({ verifiablePresentation: await signVp(vpr.challenge, vpr.domain) }),
}));
check("wrong ctx -> 400", res.statusCode === 400);

// 6. wrong challenge is rejected before any decryption
const decryptsBefore = kmsMock.commandCalls(DecryptCommand).length;
res = await lambdaHandler(event({
    exchangeId: created.exchangeId,
    query: { ctx: CTX },
    body: JSON.stringify({ verifiablePresentation: await signVp("not-the-challenge", vpr.domain) }),
}));
check("wrong challenge -> 400, no decrypt", res.statusCode === 400 &&
    kmsMock.commandCalls(DecryptCommand).length === decryptsBefore);

// 7. happy path
res = await lambdaHandler(event({
    exchangeId: created.exchangeId,
    query: { ctx: CTX },
    body: JSON.stringify({ verifiablePresentation: await signVp(vpr.challenge, vpr.domain) }),
}));
const result = JSON.parse(res.body);
const credential = result.verifiablePresentation?.verifiableCredential?.[0];
check("valid DIDAuth -> 200 with issued credential", res.statusCode === 200 && !!credential,
    res.body.slice(0, 160));
check("credential id is urn:uuid:<credId>", credential?.id === `urn:uuid:${CRED_ID}`);
check("credentialSubject.id is the wallet DID", credential?.credentialSubject?.id === holderDid);
check("subject fields come from the populated template",
    credential?.credentialSubject?.name === "Ada Lovelace" &&
    credential?.credentialSubject?.attendedEvent?.name === "VC Summit 2026");
check("proof is by the bundle's per-batch DID",
    credential?.proof?.verificationMethod?.startsWith(BATCH_DID));

// 8. the signature verifies, against the batch DID's suite
{
    const verification = await vc.verifyCredential({
        credential,
        suite: new Ed25519Signature2020(),
        documentLoader,
    });
    const { did } = await suiteFromSeed(SEED);
    check("issued credential signature verifies", verification.verified === true && did === BATCH_DID,
        verification.verified ? "" : JSON.stringify(verification.error?.errors?.[0]?.message));
}

// 9. the collection is logged by credId only, appending to the history
{
    const log = JSON.parse(objects.get("collections/logs/log.json"));
    const entry = log.credentials[CRED_ID];
    check("log.json gains collectedAt for the credId",
        typeof entry?.collectedAt === "string" && entry.collectedAt !== LEGACY_COLLECTED_AT);
    check("a legacy collectedAt folds into the collections history",
        Array.isArray(entry?.collections) &&
        entry.collections.length === 2 &&
        entry.collections[0] === LEGACY_COLLECTED_AT &&
        entry.collections[1] === entry.collectedAt &&
        entry.emailSentAt === LEGACY_COLLECTED_AT);
    check("log contains no holder or recipient data",
        !JSON.stringify(log).includes(holderDid) && !JSON.stringify(log).includes("Ada"));
}

// 10. replay: completed exchange returns the stored result without re-issuing
{
    const kmsCalls = kmsMock.commandCalls(DecryptCommand).length;
    const fetches = templateCalls;
    res = await lambdaHandler(event({
        exchangeId: created.exchangeId,
        query: { ctx: CTX },
        body: JSON.stringify({ verifiablePresentation: await signVp(vpr.challenge, vpr.domain) }),
    }));
    check("completed exchange replays its result",
        res.statusCode === 200 &&
        JSON.parse(res.body).verifiablePresentation.verifiableCredential[0].id === credential.id &&
        kmsMock.commandCalls(DecryptCommand).length === kmsCalls &&
        templateCalls === fetches);
}

// 11. the LCW mobile shape: bare VP signed over the challenge only, bare reply
{
    res = await lambdaHandler(event({ body: JSON.stringify({ credId: CRED_ID, ctx: CTX }) }));
    const mobile = JSON.parse(res.body);
    const bareVp = await signVp(mobile.verifiablePresentationRequest.challenge);
    res = await lambdaHandler(event({
        exchangeId: mobile.exchangeId,
        query: { ctx: CTX },
        body: JSON.stringify(bareVp),
    }));
    const bareResult = JSON.parse(res.body);
    check("bare VP without domain -> 200 with bare VP result", res.statusCode === 200 &&
        [bareResult?.type ?? []].flat().includes("VerifiablePresentation") &&
        bareResult?.verifiableCredential?.[0]?.credentialSubject?.id === holderDid);

    // Re-collection via a fresh exchange appends to the history rather than
    // overwriting it.
    const log = JSON.parse(objects.get("collections/logs/log.json"));
    const entry = log.credentials[CRED_ID];
    check("every collection is appended to the log history",
        entry.collections.length === 3 &&
        entry.collectedAt === entry.collections[2]);
}

// 12. a badge-issuer row (no credId) is not a batch exchange
{
    exchanges.set("badge-row", {
        exchangeId: { S: "badge-row" },
        challenge: { S: "c" },
        domain: { S: "https://issuer.example.com" },
        state: { S: "pending" },
        expiresAt: { N: String(Math.floor(Date.now() / 1000) + 900) },
    });
    res = await lambdaHandler(event({ exchangeId: "badge-row", query: { ctx: CTX }, body: "" }));
    check("badge exchange row on the batch route -> 404", res.statusCode === 404);
}

// 13. unknown exchange
res = await lambdaHandler(event({ exchangeId: randomUUID(), query: { ctx: CTX }, body: "" }));
check("unknown exchange -> 404", res.statusCode === 404);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
