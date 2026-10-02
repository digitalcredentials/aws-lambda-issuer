// The batch-credential workflow: VC-API exchanges that deliver a credential
// staged by the notify lambda. A recipient's emailed link carries credId +
// ctx; the collection page creates an exchange with both, and the ctx is
// embedded as a query parameter in the exchange URL the wallet posts back to
// (never stored in the exchange row). At participate time the ctx is the KMS
// encryption context that decrypts the bundle: a wrong ctx cannot decrypt,
// which is the whole authorization.
//
// Routes (literal workflow segment; the badge issuer keeps its wildcard):
//   POST /workflows/batch-credential/exchanges
//   POST /workflows/batch-credential/exchanges/{exchangeId}
//   GET  /workflows/batch-credential/exchanges/{exchangeId}
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import { verifyDidAuth, signCredential } from "./issue.mjs";

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
const kms = new KMSClient({});

const WORKFLOW_ID = "batch-credential";
const EXCHANGES_TABLE = process.env.TABLE_NAME;
const BUNDLES_TABLE = process.env.BUNDLES_TABLE_NAME;
const TEMPLATES_API_BASE = (process.env.TEMPLATES_API_BASE ?? "").replace(/\/+$/, "");
const EXCHANGE_TTL_SECONDS = 15 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function requestUrl(event) {
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const proto = headers["x-forwarded-proto"] ?? "https";
  const host = headers.host ?? event.requestContext?.domainName;
  return `${proto}://${host}${event.rawPath ?? event.requestContext?.http?.path ?? ""}`;
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";
  if (raw.trim() === "") {
    return {};
  }
  return JSON.parse(raw);
}

function isBareVp(body) {
  return [body?.type ?? []].flat().includes("VerifiablePresentation");
}

function didAuthRequest({ challenge, domain }) {
  return {
    verifiablePresentationRequest: {
      query: [{ type: "DIDAuthentication" }],
      challenge,
      domain,
    },
  };
}

// Reads the bundles-table pointer for a credId; null when there is none.
async function getBundlePointer(credId) {
  const { Item } = await dynamo.send(new GetItemCommand({
    TableName: BUNDLES_TABLE,
    Key: { credId: { S: credId } },
  }));
  return Item?.spaceUrl?.S ?? null;
}

async function createExchange(event) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }
  const { credId, ctx } = body;
  if (!UUID_RE.test(credId ?? "") || !UUID_RE.test(ctx ?? "")) {
    return json(400, { error: "credId and ctx are required (from the collection link)." });
  }
  if (!(await getBundlePointer(credId))) {
    return json(404, { error: "This collection link is not valid or has been revoked." });
  }

  const exchangeId = crypto.randomUUID();
  const challenge = crypto.randomUUID();
  const domain = new URL(requestUrl(event)).origin;
  const now = Math.floor(Date.now() / 1000);

  // The ctx is NOT stored: it is embedded in the exchange URL below, the
  // wallet posts back to that exact URL, and participate reads it from the
  // query string.
  await dynamo.send(new PutItemCommand({
    TableName: EXCHANGES_TABLE,
    Item: {
      exchangeId: { S: exchangeId },
      workflowId: { S: WORKFLOW_ID },
      credId: { S: credId },
      challenge: { S: challenge },
      domain: { S: domain },
      state: { S: "pending" },
      createdAt: { N: String(now) },
      expiresAt: { N: String(now + EXCHANGE_TTL_SECONDS) },
    },
  }));

  const exchangeUrl = `${requestUrl(event).replace(/\/$/, "")}/${exchangeId}?ctx=${ctx}`;
  return json(201, {
    id: exchangeUrl,
    exchangeId,
    workflowId: WORKFLOW_ID,
    state: "pending",
    verifiablePresentationRequest: {
      query: [{ type: "DIDAuthentication" }],
      challenge,
      domain,
      interact: {
        service: [
          { type: "VerifiableCredentialApiExchangeService", serviceEndpoint: exchangeUrl },
          { type: "UnmediatedPresentationService2021", serviceEndpoint: exchangeUrl },
        ],
      },
    },
  });
}

// Loads a batch exchange row; null when absent, expired, or not a
// batch-credential row (the table is shared with the badge issuer, whose rows
// carry no credId).
async function loadExchange(exchangeId) {
  const { Item } = await dynamo.send(new GetItemCommand({
    TableName: EXCHANGES_TABLE,
    Key: { exchangeId: { S: exchangeId } },
  }));
  if (!Item?.credId?.S) {
    return null;
  }
  if (Number(Item.expiresAt?.N ?? 0) < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return {
    exchangeId,
    credId: Item.credId.S,
    challenge: Item.challenge.S,
    domain: Item.domain.S,
    state: Item.state.S,
    result: Item.result?.S ? JSON.parse(Item.result.S) : undefined,
  };
}

// Decrypts the staged bundle for a credId using the ctx from the request URL.
// Every failure mode (no pointer, no object, wrong ctx) is reported the same
// way so the response reveals nothing about which part was wrong.
async function loadBundle({ credId, ctx }) {
  const invalid = () =>
    Object.assign(new Error("This collection link is not valid."), { statusCode: 400 });

  const spaceUrl = await getBundlePointer(credId);
  if (!spaceUrl) {
    throw invalid();
  }
  const bucket = spaceUrl.split("/").pop();

  let stored;
  try {
    const { Body } = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `collections/${credId}/bundle.json`,
    }));
    stored = JSON.parse(await Body.transformToString());
  } catch (err) {
    if (err.name === "NoSuchKey" || err.name === "NoSuchBucket") {
      throw invalid();
    }
    throw err;
  }

  try {
    const { Plaintext } = await kms.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(stored.ciphertext, "base64"),
      EncryptionContext: { credId, context: ctx },
    }));
    return { bundle: JSON.parse(Buffer.from(Plaintext).toString("utf8")), bucket };
  } catch (err) {
    if (err.name === "InvalidCiphertextException") {
      throw invalid();
    }
    throw err;
  }
}

// Populates the credential template with the bundle's issuer + fields via the
// credential-templates API (built for exactly this call).
async function populateTemplate({ templateId, issuer, fields }) {
  const response = await fetch(`${TEMPLATES_API_BASE}/templates/${templateId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ issuer, fields }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(
      new Error(`Template population failed (${response.status}): ${detail.slice(0, 200)}`),
      { statusCode: 502 }
    );
  }
  return response.json();
}

// Records the collection in the batch space's log, keyed by credId only — no
// holder data. Every collection appends to the entry's `collections` array
// (a link can be collected more than once via fresh exchanges); `collectedAt`
// tracks the most recent one. A logging failure does not fail the (already
// issued) exchange.
async function logCollected({ bucket, credId }) {
  try {
    let log = { entries: [], credentials: {} };
    try {
      const { Body } = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: "collections/logs/log.json",
      }));
      log = JSON.parse(await Body.transformToString());
      log.credentials ??= {};
    } catch (err) {
      if (err.name !== "NoSuchKey") {
        throw err;
      }
    }
    const entry = log.credentials[credId] ?? {};
    const collectedAt = new Date().toISOString();
    // Entries written before the history existed carry only a collectedAt;
    // fold it in as the first element.
    const collections = entry.collections
      ?? (entry.collectedAt ? [entry.collectedAt] : []);
    log.credentials[credId] = {
      ...entry,
      collectedAt,
      collections: [...collections, collectedAt],
    };
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: "collections/logs/log.json",
      Body: JSON.stringify(log),
      ContentType: "application/json",
    }));
  } catch (err) {
    console.error(`Failed to log collection of ${credId}:`, err);
  }
}

async function participate(event, exchange) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }
  const bare = isBareVp(body);

  // A completed exchange replays its stored result idempotently, in the shape
  // the caller speaks.
  if (exchange.state === "complete" && exchange.result) {
    return json(200, bare ? exchange.result.verifiablePresentation : exchange.result);
  }

  // An empty POST asks for the DIDAuth request (VC-API convention).
  if (!bare && !body.verifiablePresentation) {
    return json(200, didAuthRequest(exchange));
  }

  const ctx = event.queryStringParameters?.ctx;
  if (!UUID_RE.test(ctx ?? "")) {
    return json(400, { error: "This collection link is not valid." });
  }

  let holderDid;
  try {
    holderDid = await verifyDidAuth({
      presentation: bare ? body : body.verifiablePresentation,
      challenge: exchange.challenge,
      domain: exchange.domain,
    });
  } catch (err) {
    if (err.statusCode === 400) {
      return json(400, { error: err.message });
    }
    throw err;
  }

  let credential;
  try {
    const { bundle, bucket } = await loadBundle({ credId: exchange.credId, ctx });
    const populated = await populateTemplate({
      templateId: bundle.templateId,
      issuer: bundle.issuer,
      fields: bundle.fields,
    });
    populated.id = `urn:uuid:${exchange.credId}`;
    populated.credentialSubject = {
      ...populated.credentialSubject,
      id: holderDid,
    };
    // The Bitstring Status List position allocated at notification time; the
    // VC v2 context already carries the BitstringStatusListEntry terms.
    if (bundle.credentialStatus) {
      populated.credentialStatus = bundle.credentialStatus;
    }
    // Templates use issuer-defined terms (attendedEvent, degree, ...) beyond
    // the VC v2 context. An explicit @vocab entry maps them to the
    // issuer-dependent namespace so JSON-LD canonization accepts them; the
    // entry travels inside the credential, so verifiers canonize identically.
    const contexts = [populated["@context"] ?? []].flat();
    if (!contexts.some((c) => typeof c === "object" && c !== null && "@vocab" in c)) {
      populated["@context"] = [
        ...contexts,
        { "@vocab": "https://www.w3.org/ns/credentials/issuer-dependent#" },
      ];
    }
    credential = await signCredential({ credential: populated, seedHex: bundle.seed });
    await logCollected({ bucket, credId: exchange.credId });
  } catch (err) {
    if (err.statusCode) {
      return json(err.statusCode, { error: err.message });
    }
    throw err;
  }

  const result = {
    verifiablePresentation: {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation"],
      verifiableCredential: [credential],
    },
  };

  // The conditional update makes issuance one-shot per exchange: a concurrent
  // participate that lost the race serves the winner's stored result.
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: EXCHANGES_TABLE,
      Key: { exchangeId: { S: exchange.exchangeId } },
      UpdateExpression: "SET #s = :complete, #r = :result",
      ConditionExpression: "#s = :pending",
      ExpressionAttributeNames: { "#s": "state", "#r": "result" },
      ExpressionAttributeValues: {
        ":complete": { S: "complete" },
        ":pending": { S: "pending" },
        ":result": { S: JSON.stringify(result) },
      },
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      const winner = await loadExchange(exchange.exchangeId);
      if (winner?.result) {
        return json(200, bare ? winner.result.verifiablePresentation : winner.result);
      }
    }
    throw err;
  }

  return json(200, bare ? result.verifiablePresentation : result);
}

export const lambdaHandler = async (event) => {
  const method = event.requestContext?.http?.method;
  const exchangeId = event.pathParameters?.exchangeId;

  try {
    if (!exchangeId) {
      return method === "POST"
        ? await createExchange(event)
        : json(405, { error: "Method not allowed." });
    }

    const exchange = await loadExchange(exchangeId);
    if (!exchange) {
      return json(404, { error: "Unknown or expired exchange." });
    }
    if (method === "GET") {
      return json(200, {
        exchangeId: exchange.exchangeId,
        workflowId: WORKFLOW_ID,
        state: exchange.state,
      });
    }
    return await participate(event, exchange);
  } catch (err) {
    console.error("Batch exchange failed:", err);
    return json(500, { error: "Server error." });
  }
};
