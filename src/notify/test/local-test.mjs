// Local test for the notify handler: runs it in-process with mocked DynamoDB,
// S3, SESv2, and KMS clients, including fully signed zCap invocations.
//
//   cd src/notify && npm install && npm test
process.env.BUNDLES_TABLE_NAME = "credential-bundles";
process.env.BUNDLES_KEY_ID = "test-key-id";
process.env.COLLECTION_PAGE_URL = "https://issuer.lcw-sandbox.org";
process.env.NOTIFY_FROM_EMAIL = "issuer@lcw-sandbox.org";

import "@interop/http-client";
import { signCapabilityInvocation } from "@interop/http-signature-zcap-invoke";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { KMSClient, EncryptCommand } from "@aws-sdk/client-kms";
import { mockClient } from "aws-sdk-client-mock";

const { lambdaHandler } = await import("../app.mjs");

const HOST = "ko29d8ljta.execute-api.us-east-1.amazonaws.com";
const URL = `https://${HOST}/notify`;
const EMAIL = "owner@example.com";
const SPACE_URL = "https://was.lcw-sandbox.org/space/dcc-was-11111111-2222-3333-4444-555555555555";
const BUCKET = "dcc-was-11111111-2222-3333-4444-555555555555";

// A did:key whose private key we hold, standing in for the wallet's key
const key = await Ed25519VerificationKey.generate();
const did = `did:key:${key.fingerprint()}`;
key.id = `${did}#${key.fingerprint()}`;
key.controller = did;

const ddbMock = mockClient(DynamoDBClient);
const s3Mock = mockClient(S3Client);
const sesMock = mockClient(SESv2Client);
const kmsMock = mockClient(KMSClient);

// In-memory batch bucket, so log.json read-merge-write round-trips.
let objects;

function resetMocks({ registeredDid, spaceRow } = {}) {
  ddbMock.reset();
  s3Mock.reset();
  sesMock.reset();
  kmsMock.reset();
  objects = new Map();

  ddbMock.on(GetItemCommand, { TableName: "wallet-test" }).resolves(
    registeredDid ? { Item: { email: { S: EMAIL }, did: { S: registeredDid } } } : {}
  );
  ddbMock.on(GetItemCommand, { TableName: "wallet-spaces" }).resolves(
    spaceRow === undefined
      ? { Item: { spaceURL: { S: SPACE_URL }, did: { S: registeredDid ?? "" }, type: { L: [{ S: "Space" }, { S: "BatchSpace" }] } } }
      : spaceRow
        ? { Item: spaceRow }
        : {}
  );
  ddbMock.on(PutItemCommand).resolves({});

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

  sesMock.on(SendEmailCommand).resolves({ MessageId: "m" });
  kmsMock.on(EncryptCommand).callsFake(({ Plaintext }) => ({
    CiphertextBlob: Buffer.concat([Buffer.from("enc:"), Buffer.from(Plaintext)]),
  }));
}

function makeEvent({ body, headers = {} }) {
  return {
    rawPath: "/notify",
    rawQueryString: "",
    isBase64Encoded: false,
    headers,
    body,
    requestContext: { domainName: HOST, http: { method: "POST" } },
  };
}

const batch = (rows) => ({
  id: "batch-1",
  spaceUrl: SPACE_URL,
  name: "VC Summit 2026 attendance",
  templateId: "conference",
  issuer: { name: "VC Summit", url: "https://summit.example.org" },
  rows,
});

async function signedEvent(json) {
  const headers = await signCapabilityInvocation({
    url: URL,
    method: "POST",
    headers: { host: HOST },
    json,
    capabilityAction: "write",
    invocationSigner: key.signer(),
  });
  return makeEvent({ body: JSON.stringify(json), headers });
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

const ROWS = [
  { recipientName: "Ada Lovelace", recipientEmail: "ada@example.com", conferenceName: "VC Summit" },
  { recipientName: "Grace Hopper", recipientEmail: "grace@example.com", conferenceName: "VC Summit" },
];

// -- validation and auth

resetMocks({ registeredDid: did });
let res = await lambdaHandler(makeEvent({ body: "not json" }));
check("bad JSON body -> 400", res.statusCode === 400);

resetMocks({ registeredDid: did });
res = await lambdaHandler(await signedEvent({ email: EMAIL, batch: { spaceUrl: SPACE_URL } }));
check("batch without rows/template -> 400", res.statusCode === 400);

resetMocks({ registeredDid: did });
res = await lambdaHandler(makeEvent({ body: JSON.stringify({ email: EMAIL, batch: batch(ROWS) }) }));
check("unsigned -> 401", res.statusCode === 401);

resetMocks({});
res = await lambdaHandler(await signedEvent({ email: EMAIL, batch: batch(ROWS) }));
check("email not registered -> 401", res.statusCode === 401);

resetMocks({
  registeredDid: did,
  spaceRow: { spaceURL: { S: SPACE_URL }, did: { S: "did:key:z6MkfDLjE5Kip9E7YRitEbrNAcCYi2AviAY8Ny7hoYnCSgav" }, type: { L: [{ S: "Space" }, { S: "BatchSpace" }] } },
});
res = await lambdaHandler(await signedEvent({ email: EMAIL, batch: batch(ROWS) }));
check("space owned by another account -> 404", res.statusCode === 404);

resetMocks({
  registeredDid: did,
  spaceRow: { spaceURL: { S: SPACE_URL }, did: { S: did }, type: { L: [{ S: "Space" }] } },
});
res = await lambdaHandler(await signedEvent({ email: EMAIL, batch: batch(ROWS) }));
check("credential space -> 404", res.statusCode === 404);

// -- happy path

resetMocks({ registeredDid: did });
res = await lambdaHandler(await signedEvent({ email: EMAIL, batch: batch(ROWS) }));
const result = JSON.parse(res.body);
check("happy path -> 200 with 2 sent", res.statusCode === 200 && result.sent === 2 && result.failures.length === 0,
  res.body.slice(0, 120));

{
  const credIds = Object.keys(result.credentials);
  check("two credential entries returned", credIds.length === 2);

  const s3Puts = s3Mock.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
  const bundleKeys = s3Puts.filter(({ Key }) => Key.endsWith("/bundle.json")).map(({ Key }) => Key);
  check("a bundle.json per credential in its own collection",
    bundleKeys.length === 2 &&
    credIds.every((id) => bundleKeys.includes(`collections/${id}/bundle.json`)) &&
    s3Puts.every(({ Bucket }) => Bucket === BUCKET));

  const encrypts = kmsMock.commandCalls(EncryptCommand).map((c) => c.args[0].input);
  const contexts = encrypts.map(({ EncryptionContext }) => EncryptionContext);
  check("KMS encryption context carries credId + per-credential context UUID",
    encrypts.length === 2 &&
    contexts.every(({ credId, context }) => credIds.includes(credId) && /^[0-9a-f-]{36}$/.test(context)) &&
    contexts[0].context !== contexts[1].context);

  const bundle = JSON.parse(
    JSON.parse(objects.get(bundleKeys[0])).ciphertext
      ? Buffer.from(JSON.parse(objects.get(bundleKeys[0])).ciphertext, "base64").toString().slice("enc:".length)
      : "{}"
  );
  check("bundle carries fields, seed, and did",
    bundle.templateId === "conference" &&
    bundle.fields?.recipientEmail?.endsWith("@example.com") &&
    /^[0-9a-f]{64}$/.test(bundle.seed) &&
    bundle.did?.startsWith("did:key:z6Mk"));

  const ddbPuts = ddbMock.commandCalls(PutItemCommand).map((c) => c.args[0].input);
  check("bundles table rows are credId -> space pointers only",
    ddbPuts.length === 2 &&
    ddbPuts.every(({ TableName, Item }) =>
      TableName === "credential-bundles" &&
      credIds.includes(Item.credId.S) &&
      Item.spaceUrl.S === SPACE_URL &&
      Item.bundle === undefined && Item.ciphertext === undefined));

  const sends = sesMock.commandCalls(SendEmailCommand).map((c) => c.args[0].input);
  const links = sends.map(({ Content }) => Content.Simple.Body.Text.Data.match(/https:\S+/)[0]);
  check("emails go to recipients with credId+ctx collection links",
    sends.length === 2 &&
    sends[0].Destination.ToAddresses[0] === "ada@example.com" &&
    links.every((link, i) => {
      const url = new global.URL(link);
      return url.origin === "https://issuer.lcw-sandbox.org" &&
        credIds.includes(url.searchParams.get("credId")) &&
        /^[0-9a-f-]{36}$/.test(url.searchParams.get("ctx"));
    }));

  const ctxInEmail = new global.URL(links[0]).searchParams.get("ctx");
  check("context UUID appears only in the email",
    !res.body.includes(ctxInEmail) && !objects.get("collections/logs/log.json").includes(ctxInEmail));

  const logsMeta = JSON.parse(objects.get("meta/logs.json") ?? "null");
  check("logs collection has its metadata object",
    logsMeta?.name === "Logs" && Array.isArray(logsMeta.type));

  const log = JSON.parse(objects.get("collections/logs/log.json"));
  check("log has a notification-triggered entry and per-credId records",
    log.entries.some(({ type, recipientCount }) => type === "notification-triggered" && recipientCount === 2) &&
    credIds.every((id) => typeof log.credentials[id]?.emailSentAt === "string"));
  check("log contains no recipient PII",
    !JSON.stringify(log).includes("example.com") && !JSON.stringify(log).includes("Ada"));
}

// -- partial failures

resetMocks({ registeredDid: did });
res = await lambdaHandler(await signedEvent({
  email: EMAIL,
  batch: batch([ROWS[0], { recipientName: "No Email" }, { recipientEmail: "big@example.com", blob: "x".repeat(5000) }]),
}));
{
  const partial = JSON.parse(res.body);
  const sends = sesMock.commandCalls(SendEmailCommand);
  check("rows without email or too large fail individually, rest send",
    res.statusCode === 200 && partial.sent === 1 && partial.failures.length === 2 && sends.length === 1,
    res.body.slice(0, 160));
  check("failure reasons name the problem",
    partial.failures.some(({ reason }) => /recipientEmail/.test(reason)) &&
    partial.failures.some(({ reason }) => /too large/.test(reason)));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
