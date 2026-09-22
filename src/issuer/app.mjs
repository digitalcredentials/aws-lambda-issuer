import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { verifyDidAuth, issueBadge } from "./issue.mjs";

const dynamo = new DynamoDBClient({});
const ses = new SESv2Client({});
const TABLE_NAME = process.env.TABLE_NAME;
const MAX_NAME_LENGTH = 100;

// The single workflow this issuer serves.
const WORKFLOW_ID = "lcw-sandbox-badge";
const EXCHANGE_TTL_SECONDS = 15 * 60;

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

// The DIDAuthentication step of the exchange, per the VP Request spec shapes
// VCALM uses.
function didAuthRequest({ challenge, domain }) {
  return {
    verifiablePresentationRequest: {
      query: [{ type: "DIDAuthentication" }],
      challenge,
      domain,
    },
  };
}

// Sends "your credential is ready" to the given address, linking to the
// collection page with the recipient's name as a query parameter, so the
// eventual credential carries it.
async function notify(event) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    return json(400, { error: `"name" is required (at most ${MAX_NAME_LENGTH} characters).` });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: '"email" must be a valid email address.' });
  }

  const claimUrl = `${process.env.COLLECTION_PAGE_URL}/?name=${encodeURIComponent(name)}`;
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: process.env.NOTIFY_FROM_EMAIL,
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: {
          Subject: { Data: "Your LCW Sandbox Badge is ready to claim" },
          Body: {
            Text: {
              Data:
                `Hello ${name},\n\n` +
                `A credential — the LCW Sandbox Badge, issued to ${name} — is ready for you to collect.\n\n` +
                `Open this link and click "Add to Wallet" to claim it into your Learner Credential Wallet:\n\n` +
                `${claimUrl}\n\n` +
                `You'll need a wallet registered with your browser (in the LCW sandbox, use "Enable browser wallet").\n\n` +
                `— LCW Sandbox Issuer`,
            },
            Html: {
              Data:
                `<p>Hello ${escapeHtml(name)},</p>` +
                `<p>A credential — the <strong>LCW Sandbox Badge</strong>, issued to ${escapeHtml(name)} — is ready for you to collect.</p>` +
                `<p><a href="${claimUrl}">Open the collection page</a> and click <strong>Add to Wallet</strong> to claim it into your Learner Credential Wallet.</p>` +
                `<p>You'll need a wallet registered with your browser (in the LCW sandbox, use "Enable browser wallet").</p>` +
                `<p>— LCW Sandbox Issuer</p>`,
            },
          },
        },
      },
    })
  );
  return json(200, { sent: true });
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function createExchange(event) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }
  // Optional: the name the notification link carried, to put on the credential
  const holderName =
    typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME_LENGTH) : "";

  const exchangeId = crypto.randomUUID();
  const challenge = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const domain = new URL(requestUrl(event)).origin;

  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        exchangeId: { S: exchangeId },
        challenge: { S: challenge },
        domain: { S: domain },
        state: { S: "pending" },
        createdAt: { N: String(now) },
        expiresAt: { N: String(now + EXCHANGE_TTL_SECONDS) },
        ...(holderName && { holderName: { S: holderName } }),
      },
    })
  );

  const exchangeUrl = `${requestUrl(event).replace(/\/$/, "")}/${exchangeId}`;
  return json(201, {
    id: exchangeUrl,
    exchangeId,
    workflowId: WORKFLOW_ID,
    state: "pending",
    // What the collection page hands to the wallet via CHAPI
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

async function loadExchange(exchangeId) {
  const { Item } = await dynamo.send(
    new GetItemCommand({ TableName: TABLE_NAME, Key: { exchangeId: { S: exchangeId } } })
  );
  if (!Item || Number(Item.expiresAt?.N ?? 0) < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return {
    exchangeId,
    challenge: Item.challenge.S,
    domain: Item.domain.S,
    state: Item.state.S,
    holderName: Item.holderName?.S,
    result: Item.result?.S ? JSON.parse(Item.result.S) : undefined,
  };
}

// The LCW mobile wallet POSTs its signed presentation as the request body
// itself (the web flow wraps it in {verifiablePresentation}) and expects the
// response to be the presentation holding the credential, unwrapped.
function isBareVp(body) {
  return [body?.type ?? []].flat().includes("VerifiablePresentation");
}

async function participate(event, exchange) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }
  const bare = isBareVp(body);

  // A completed exchange replays its result (idempotent for retries)
  if (exchange.state === "complete") {
    return json(200, bare ? exchange.result.verifiablePresentation : exchange.result);
  }

  // No presentation yet: answer with the DIDAuthentication request
  if (!bare && !body.verifiablePresentation) {
    return json(200, didAuthRequest(exchange));
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

  const credential = await issueBadge({ holderDid, holderName: exchange.holderName });
  const result = {
    verifiablePresentation: {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation"],
      verifiableCredential: [credential],
    },
  };

  await dynamo.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { exchangeId: { S: exchange.exchangeId } },
      UpdateExpression: "SET #s = :complete, #r = :result",
      ExpressionAttributeNames: { "#s": "state", "#r": "result" },
      ExpressionAttributeValues: {
        ":complete": { S: "complete" },
        ":result": { S: JSON.stringify(result) },
      },
    })
  );

  return json(200, bare ? result.verifiablePresentation : result);
}

export const lambdaHandler = async (event) => {
  const { workflowId, exchangeId } = event.pathParameters ?? {};
  const method = event.requestContext?.http?.method ?? event.httpMethod;

  if (workflowId !== WORKFLOW_ID) {
    return json(404, { error: `Unknown workflow "${workflowId}".` });
  }

  try {
    const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
    if (path.endsWith("/notifications")) {
      return method === "POST"
        ? await notify(event)
        : json(405, { error: "Method not allowed" });
    }

    if (!exchangeId) {
      return method === "POST"
        ? await createExchange(event)
        : json(405, { error: "Method not allowed" });
    }

    const exchange = await loadExchange(exchangeId);
    if (!exchange) {
      return json(404, { error: "Unknown or expired exchange." });
    }

    if (method === "GET") {
      return json(200, {
        exchangeId,
        workflowId: WORKFLOW_ID,
        state: exchange.state,
      });
    }
    return await participate(event, exchange);
  } catch (err) {
    console.error("Unhandled error in issuer handler:", err);
    return json(500, { error: "Server error." });
  }
};
