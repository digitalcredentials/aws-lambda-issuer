// Local test for the issuer: drives a complete VCALM exchange in-process with
// a mocked DynamoDB, playing the wallet side with its own did:key, and
// verifies the issued credential's signature.
//
//   cd src/issuer && npm install && npm test
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import * as vc from "@digitalbazaar/vc";
import { Ed25519Signature2020 } from "@digitalbazaar/ed25519-signature-2020";
import { Ed25519VerificationKey2020 } from "@digitalbazaar/ed25519-verification-key-2020";

process.env.ISSUER_SEED = "5b".repeat(32);
process.env.TABLE_NAME = "exchanges-test";

const { lambdaHandler } = await import("../app.mjs");
const { documentLoader, issuerSuite } = await import("../issue.mjs");

const ddb = mockClient(DynamoDBClient);
const store = new Map();
ddb.on(PutItemCommand).callsFake((input) => {
    store.set(input.Item.exchangeId.S, input.Item);
    return {};
});
ddb.on(GetItemCommand).callsFake((input) => ({ Item: store.get(input.Key.exchangeId.S) }));
ddb.on(UpdateItemCommand).callsFake((input) => {
    const item = store.get(input.Key.exchangeId.S);
    item.state = input.ExpressionAttributeValues[":complete"];
    item.result = input.ExpressionAttributeValues[":result"];
    return {};
});

const event = ({ exchangeId, body, method = "POST", workflowId = "lcw-sandbox-badge" } = {}) => ({
    pathParameters: { workflowId, ...(exchangeId && { exchangeId }) },
    rawPath: `/workflows/${workflowId}/exchanges${exchangeId ? `/${exchangeId}` : ""}`,
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

// 1. unknown workflow
let res = await lambdaHandler(event({ workflowId: "nope" }));
check("unknown workflow -> 404", res.statusCode === 404);

// 2. create an exchange
res = await lambdaHandler(event());
const created = JSON.parse(res.body);
check("create exchange -> 201 with challenge + interact service", res.statusCode === 201 &&
    !!created.verifiablePresentationRequest.challenge &&
    created.verifiablePresentationRequest.interact.service[0].serviceEndpoint.endsWith(created.exchangeId));

// 3. empty participate -> DIDAuthentication request
res = await lambdaHandler(event({ exchangeId: created.exchangeId }));
const vpr = JSON.parse(res.body).verifiablePresentationRequest;
check("empty POST -> DIDAuthentication request", res.statusCode === 200 &&
    vpr.query[0].type === "DIDAuthentication" && !!vpr.challenge && !!vpr.domain);

// 4. the wallet side: a fresh did:key signs the DIDAuth presentation
const holderKey = await Ed25519VerificationKey2020.generate();
const holderDid = `did:key:${holderKey.fingerprint()}`;
holderKey.controller = holderDid;
holderKey.id = `${holderDid}#${holderKey.fingerprint()}`;
const presentation = vc.createPresentation({ holder: holderDid });
const signedVp = await vc.signPresentation({
    presentation,
    suite: new Ed25519Signature2020({ key: holderKey }),
    challenge: vpr.challenge,
    domain: vpr.domain,
    documentLoader,
});

// 5. wrong challenge is rejected
const badVp = await vc.signPresentation({
    presentation: vc.createPresentation({ holder: holderDid }),
    suite: new Ed25519Signature2020({ key: holderKey }),
    challenge: "not-the-challenge",
    domain: vpr.domain,
    documentLoader,
});
res = await lambdaHandler(event({ exchangeId: created.exchangeId, body: JSON.stringify({ verifiablePresentation: badVp }) }));
check("wrong challenge -> 400", res.statusCode === 400);

// 6. valid DIDAuth -> issued credential bound to the holder
res = await lambdaHandler(event({ exchangeId: created.exchangeId, body: JSON.stringify({ verifiablePresentation: signedVp }) }));
const result = JSON.parse(res.body);
const credential = result.verifiablePresentation?.verifiableCredential?.[0];
const { did: issuerDid } = await issuerSuite();
check("valid DIDAuth -> 200 with issued credential", res.statusCode === 200 && !!credential);
check("credentialSubject.id is the wallet DID", credential?.credentialSubject?.id === holderDid);
check("issuer is the seed-derived DID", credential?.issuer?.id === issuerDid);

// 7. the signature verifies with the same stack veri-good uses
const verification = await vc.verifyCredential({
    credential,
    suite: new Ed25519Signature2020(),
    documentLoader,
});
check("issued credential signature verifies", verification.verified === true,
    verification.verified ? "" : JSON.stringify(verification.error?.errors?.[0]?.message));

// 8. replaying the completed exchange returns the same result
res = await lambdaHandler(event({ exchangeId: created.exchangeId }));
check("completed exchange replays its result", res.statusCode === 200 &&
    JSON.parse(res.body).verifiablePresentation.verifiableCredential[0].id === credential.id);

// 9. unknown exchange
res = await lambdaHandler(event({ exchangeId: "nope" }));
check("unknown exchange -> 404", res.statusCode === 404);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
