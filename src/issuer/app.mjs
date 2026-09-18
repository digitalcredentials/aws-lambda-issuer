import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { verifyDidAuth, issueBadge } from "./issue.mjs";

const dynamo = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;

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

async function createExchange(event) {
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
    result: Item.result?.S ? JSON.parse(Item.result.S) : undefined,
  };
}

async function participate(event, exchange) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }

  // A completed exchange replays its result (idempotent for retries)
  if (exchange.state === "complete") {
    return json(200, exchange.result);
  }

  // No presentation yet: answer with the DIDAuthentication request
  if (!body.verifiablePresentation) {
    return json(200, didAuthRequest(exchange));
  }

  let holderDid;
  try {
    holderDid = await verifyDidAuth({
      presentation: body.verifiablePresentation,
      challenge: exchange.challenge,
      domain: exchange.domain,
    });
  } catch (err) {
    if (err.statusCode === 400) {
      return json(400, { error: err.message });
    }
    throw err;
  }

  const credential = await issueBadge({ holderDid });
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

  return json(200, result);
}

export const lambdaHandler = async (event) => {
  const { workflowId, exchangeId } = event.pathParameters ?? {};
  const method = event.requestContext?.http?.method ?? event.httpMethod;

  if (workflowId !== WORKFLOW_ID) {
    return json(404, { error: `Unknown workflow "${workflowId}".` });
  }

  try {
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
