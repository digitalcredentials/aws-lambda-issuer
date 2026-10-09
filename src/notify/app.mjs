// POST /notify — emails every recipient in a batch a link to collect their
// credential, staging an encrypted per-credential bundle in the batch's WAS
// space on the way.
//
// The request is a zcap invocation of its own URL signed by the DID registered
// for the email (the wallet's session key), and the batch space named in the
// posted batch must be registered to that account as a batch space.
//
// Must be evaluated before @interop/jsonld (CJS) is pulled in below, which
// require()s this ESM package mid-graph and hits a TDZ error otherwise.
import "@interop/http-client";
import { randomUUID, randomBytes } from "node:crypto";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { KMSClient, EncryptCommand } from "@aws-sdk/client-kms";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";
import { verifyAccountInvocation } from "./verify.mjs";

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
const ses = new SESv2Client({});
const kms = new KMSClient({});

const ACCOUNTS_TABLE = process.env.TABLE_NAME ?? "wallet-test";
const SPACES_TABLE = process.env.SPACES_TABLE_NAME ?? "wallet-spaces";
const BUNDLES_TABLE = process.env.BUNDLES_TABLE_NAME;
const BUNDLES_KEY_ID = process.env.BUNDLES_KEY_ID;
const COLLECTION_PAGE_URL = (process.env.COLLECTION_PAGE_URL ?? "").replace(/\/+$/, "");
const NOTIFY_FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL;

// KMS Encrypt takes at most 4096 plaintext bytes; bundles are small (one CSV
// row plus a seed), so hitting this means a runaway row, not a design problem.
const KMS_PLAINTEXT_LIMIT = 4096;

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";
  if (raw.trim() === "") {
    return {};
  }
  return JSON.parse(raw);
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function readJson(bucket, key) {
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await Body.transformToString());
  } catch (err) {
    if (err.name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}

async function writeJson(bucket, key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
  }));
}

// Gives the batch space's `logs` collection (created here, written directly
// to the bucket) its Collection Metadata object in the WAS v0.5 layout, so
// it is listed by name; an existing object is left alone. The `batch`
// collection is created by the batch-issuer panel through the server.
async function ensureLogsMetadata(bucket) {
  if ((await readJson(bucket, "meta/logs.json")) !== null) {
    return;
  }
  const now = new Date().toISOString();
  await writeJson(bucket, "meta/logs.json", {
    id: "logs",
    type: ["Collection"],
    name: "Logs",
    createdAt: now,
    updatedAt: now,
  });
}

function notificationEmail({ recipientEmail, recipientName, issuerName, collectUrl }) {
  const greeting = recipientName ? `Hello ${recipientName},` : "Hello,";
  return new SendEmailCommand({
    FromEmailAddress: NOTIFY_FROM_EMAIL,
    Destination: { ToAddresses: [recipientEmail] },
    Content: {
      Simple: {
        Subject: { Data: `A credential from ${issuerName} is ready to collect` },
        Body: {
          Text: {
            Data:
              `${greeting}\n\n` +
              `${issuerName} has issued you a credential, and it is ready for you to collect.\n\n` +
              `Open this link to collect it into your wallet:\n\n` +
              `${collectUrl}\n\n` +
              `— ${issuerName}`,
          },
          Html: {
            Data:
              `<p>${escapeHtml(greeting)}</p>` +
              `<p><strong>${escapeHtml(issuerName)}</strong> has issued you a credential, and it is ready for you to collect.</p>` +
              `<p><a href="${collectUrl}">Collect your credential</a></p>` +
              `<p>— ${escapeHtml(issuerName)}</p>`,
          },
        },
      },
    },
  });
}

export const lambdaHandler = async (event) => {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }
  const { email, batch } = body;
  if (!email) {
    return json(400, { error: "Missing email." });
  }
  if (!batch?.spaceUrl || !batch?.templateId || !Array.isArray(batch?.rows) || !batch.rows.length) {
    return json(400, {
      error: "batch must have a spaceUrl, a templateId, and at least one row.",
    });
  }

  // The DID registered for the email controls the invoked root capability.
  let account;
  try {
    ({ Item: account } = await dynamo.send(new GetItemCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { email: { S: email } },
    })));
  } catch (err) {
    console.error("Error looking up account:", err);
    return json(500, { error: "Failed to look up account." });
  }
  const registeredDid = account?.did?.S?.split("#")[0];
  if (!registeredDid || !(await verifyAccountInvocation({ event, registeredDid }))) {
    return json(401, { error: "Unauthorized." });
  }

  // The batch space must be registered to this account's DID as a batch
  // space (registry rows are keyed to the controller DID and carry no email);
  // 404 otherwise so nothing is revealed about other accounts' spaces.
  const { Item: spaceRow } = await dynamo.send(new GetItemCommand({
    TableName: SPACES_TABLE,
    Key: { spaceURL: { S: batch.spaceUrl } },
  }));
  // The registry's `type` is the Space's type array; a batch space carries
  // "BatchSpace" (rows from before v0.5 held the string 'batch').
  const spaceTypes = spaceRow?.type?.L
    ? spaceRow.type.L.map((entry) => entry.S)
    : spaceRow?.type?.S === "batch" ? ["Space", "BatchSpace"] : ["Space"];
  if (!spaceRow || spaceRow.did?.S?.split("#")[0] !== registeredDid || !spaceTypes.includes("BatchSpace")) {
    return json(404, { error: "No such batch space." });
  }
  const bucket = batch.spaceUrl.split("/").pop();

  try {
    // One signing seed for the whole notification run; each bundle carries it
    // so the credential can be signed at collection time.
    const seedBytes = randomBytes(32);
    const seed = seedBytes.toString("hex");
    const signingKey = await Ed25519VerificationKey.generate({ seed: new Uint8Array(seedBytes) });
    const did = `did:key:${signingKey.fingerprint()}`;

    await ensureLogsMetadata(bucket);

    const log = (await readJson(bucket, "collections/logs/log.json")) ?? {
      entries: [],
      credentials: {},
    };
    log.entries ??= [];
    log.credentials ??= {};
    log.entries.push({
      type: "notification-triggered",
      at: new Date().toISOString(),
      recipientCount: batch.rows.length,
    });

    const issuerName = batch.issuer?.name || batch.name || "The issuer";
    const failures = [];
    const credentials = {};
    // credId -> row index, returned to the caller only (never logged): the
    // batch owner's UI joins it with the batch document's own rows to show
    // which credential belongs to whom, while the log stays free of
    // recipient data.
    const recipientRows = {};

    for (const [index, row] of batch.rows.entries()) {
      const recipientEmail = (row.recipientEmail ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
        failures.push({ row: index, reason: "Missing or invalid recipientEmail." });
        continue;
      }
      try {
        const credId = randomUUID();
        const context = randomUUID();
        // A row that was notified before carries the credId of that earlier
        // staging; it is a bookkeeping key on the row, not template data.
        const { credId: previouslyStaged, ...fields } = row;
        const plaintext = JSON.stringify({
          credId,
          batchName: batch.name,
          templateId: batch.templateId,
          issuer: batch.issuer,
          fields,
          seed,
          did,
        });
        if (Buffer.byteLength(plaintext) > KMS_PLAINTEXT_LIMIT) {
          failures.push({ row: index, reason: "Credential data too large to encrypt." });
          continue;
        }

        // The context UUID travels only in the recipient's email; presenting
        // it back is what authorizes decryption at collection time.
        const { CiphertextBlob } = await kms.send(new EncryptCommand({
          KeyId: BUNDLES_KEY_ID,
          Plaintext: Buffer.from(plaintext),
          EncryptionContext: { credId, context },
        }));

        // The one ciphertext copy lives in the owner's batch space; the
        // bundles table is just a credId -> space pointer for collection.
        await writeJson(bucket, `collections/${credId}/bundle.json`, {
          keyId: BUNDLES_KEY_ID,
          ciphertext: Buffer.from(CiphertextBlob).toString("base64"),
        });
        await dynamo.send(new PutItemCommand({
          TableName: BUNDLES_TABLE,
          Item: {
            credId: { S: credId },
            spaceUrl: { S: batch.spaceUrl },
            CreatedAt: { S: new Date().toISOString() },
          },
        }));

        const collectUrl = `${COLLECTION_PAGE_URL}/?credId=${credId}&ctx=${context}`;
        await ses.send(notificationEmail({
          recipientEmail,
          recipientName: row.recipientName,
          issuerName,
          collectUrl,
        }));

        // The log records progress by credId only - no recipient data. The
        // credential's status position is allocated (and its revocation token
        // recorded here) at collection time, by the batch-exchange lambda.
        credentials[credId] = { emailSentAt: new Date().toISOString() };
        recipientRows[credId] = index;
      } catch (err) {
        console.error(`Notify failed for row ${index}:`, err);
        failures.push({ row: index, reason: "Failed to stage or send." });
      }
    }

    Object.assign(log.credentials, credentials);
    await writeJson(bucket, "collections/logs/log.json", log);

    return json(200, { sent: Object.keys(credentials).length, failures, credentials, recipientRows });
  } catch (err) {
    console.error(`Notify failed for ${batch.spaceUrl}:`, err);
    return json(500, { error: "Server error." });
  }
};
