// POST /notify — emails every recipient in a batch a link to collect their
// credential, staging an encrypted per-credential bundle in the batch's WAS
// space on the way.
//
// The request is a zcap invocation of its own URL signed by the DID registered
// for the email (the wallet's session key), and the batch space named in the
// posted batch must be registered to that account with type 'batch'.
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

// Marks the batch space's bookkeeping collections as special: `logs` (created
// here) and `batch` (created by the batch-issuer panel), so UIs can tell them
// apart from ordinary credential collections.
async function markSpecialCollections(bucket) {
  await writeJson(bucket, "collections/logs/description.json", {
    id: "logs",
    name: "Logs",
    type: ["Collection"],
    special: true,
  });
  const batchDescription = await readJson(bucket, "collections/batch/description.json");
  await writeJson(bucket, "collections/batch/description.json", {
    id: "batch",
    name: "Batch",
    type: ["Collection"],
    ...batchDescription,
    special: true,
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
  if (!spaceRow || spaceRow.did?.S?.split("#")[0] !== registeredDid || spaceRow.type?.S !== "batch") {
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

    await markSpecialCollections(bucket);

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

    for (const [index, row] of batch.rows.entries()) {
      const recipientEmail = (row.recipientEmail ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
        failures.push({ row: index, reason: "Missing or invalid recipientEmail." });
        continue;
      }
      try {
        const credId = randomUUID();
        const context = randomUUID();
        const plaintext = JSON.stringify({
          credId,
          batchName: batch.name,
          templateId: batch.templateId,
          issuer: batch.issuer,
          fields: row,
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
      } catch (err) {
        console.error(`Notify failed for row ${index}:`, err);
        failures.push({ row: index, reason: "Failed to stage or send." });
      }
    }

    Object.assign(log.credentials, credentials);
    await writeJson(bucket, "collections/logs/log.json", log);

    return json(200, { sent: Object.keys(credentials).length, failures, credentials });
  } catch (err) {
    console.error(`Notify failed for ${batch.spaceUrl}:`, err);
    return json(500, { error: "Server error." });
  }
};
