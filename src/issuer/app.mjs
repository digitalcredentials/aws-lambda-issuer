import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { verifyDidAuth, issueBadge } from "./issue.mjs";
import { ORG_NAME, emailHtml, escapeHtml } from "./email.mjs";

const dynamo = new DynamoDBClient({});
const ses = new SESv2Client({});
const TABLE_NAME = process.env.TABLE_NAME;
const MAX_NAME_LENGTH = 100;

// The single workflow this issuer serves.
const WORKFLOW_ID = "lcw-sandbox-badge";
const EXCHANGE_TTL_SECONDS = 15 * 60;

// Who may have the badge (issue 27). A request has to carry one of:
//
//   - `code`: the claim code (CLAIM_CODE), typed into the claim page's form;
//   - `grant`: a wallet account's grant, which the wallet gets from its back
//     end (WALLET_API_BASE) and which is good for one badge per account;
//   - `token`: what an emailed link carries. The notification mints it once
//     a code or a grant has been accepted, and it is good for one badge.
//
// A notification takes a code or a grant; an exchange takes a token or a
// code. A token is kept in the exchanges table under `token#<value>`.
const CLAIM_CODE = process.env.CLAIM_CODE ?? "";
const WALLET_API_BASE = (process.env.WALLET_API_BASE ?? "").replace(/\/+$/, "");
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
const tokenKey = (token) => ({ exchangeId: { S: `token#${token}` } });

const refusal = (error) => Object.assign(new Error(error), { statusCode: 403 });

function codeAccepted(code) {
  if (!CLAIM_CODE || typeof code !== "string") {
    return false;
  }
  const given = Buffer.from(code.trim(), "utf8");
  const wanted = Buffer.from(CLAIM_CODE, "utf8");
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// Asks the wallet's back end about a grant: whether it is good, and with
// `consume`, to mark it used. Throws the refusal to answer with otherwise.
async function redeemGrant(grant, { consume }) {
  if (!WALLET_API_BASE || typeof grant !== "string" || !grant) {
    throw refusal("This request does not come from a wallet account.");
  }
  const res = await fetch(`${WALLET_API_BASE}/badge-grant/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant, consume }),
  });
  if (res.status === 409) {
    throw refusal("This wallet account has already collected its badge.");
  }
  if (res.status === 404) {
    throw refusal("This request does not come from a wallet account.");
  }
  if (!res.ok) {
    throw new Error(`The wallet's back end answered ${res.status} to a grant check.`);
  }
}

async function loadToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    return null;
  }
  const { Item } = await dynamo.send(new GetItemCommand({ TableName: TABLE_NAME, Key: tokenKey(token) }));
  if (!Item || Number(Item.expiresAt?.N ?? 0) < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return { token, grant: Item.grant?.S, holderName: Item.holderName?.S, used: Boolean(Item.usedAt?.N) };
}

// Uses up the token an exchange was created with, as its badge is issued:
// the account's grant first (the back end allows that once), then the token
// itself. Throws the refusal when either was already used.
async function useToken(token) {
  const found = await loadToken(token);
  if (!found || found.used) {
    throw refusal("This link has already been used.");
  }
  if (found.grant) {
    await redeemGrant(found.grant, { consume: true });
  }
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: tokenKey(token),
        UpdateExpression: "SET usedAt = :now",
        ConditionExpression: "attribute_exists(exchangeId) AND attribute_not_exists(usedAt)",
        ExpressionAttributeValues: { ":now": { N: String(Math.floor(Date.now() / 1000)) } },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      throw refusal("This link has already been used.");
    }
    throw err;
  }
}

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
      query: [
        {
          type: "DIDAuthentication",
          // The holder DIDs this issuer verifies: a did:web (the wallet's
          // account projection, resolved over HTTPS) or a did:key.
          acceptedMethods: [{ method: "web" }, { method: "key" }],
        },
      ],
      challenge,
      domain,
    },
  };
}

// Sends "your badge is ready" to the given address, once the request's code
// or grant is accepted. The link opens the collection page with the
// recipient's name and a token that is good for one badge.
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

  let grant;
  try {
    if (body.grant !== undefined) {
      await redeemGrant(body.grant, { consume: false });
      grant = body.grant;
    } else if (!codeAccepted(body.code)) {
      throw refusal(body.code ? "That code isn't valid." : "A code is required.");
    }
  } catch (err) {
    if (err.statusCode === 403) {
      return json(403, { error: err.message });
    }
    throw err;
  }
  const token = randomBytes(24).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        ...tokenKey(token),
        holderName: { S: name },
        createdAt: { N: String(now) },
        expiresAt: { N: String(now + LINK_TTL_SECONDS) },
        ...(grant && { grant: { S: grant } }),
      },
    })
  );

  const claimUrl = `${process.env.COLLECTION_PAGE_URL}/?name=${encodeURIComponent(name)}&token=${token}`;
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: process.env.NOTIFY_FROM_EMAIL,
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: {
          Subject: { Data: "Your LCW Alpha Testing Badge is ready" },
          Body: {
            // The same wording in both versions; the sign-off is the HTML
            // layout's footer
            Text: {
              Data:
                `Hi ${name}, your LCW Alpha Testing Badge is ready. Open the link and choose Add to Web Wallet to add it to your Learner Credential Wallet.\n\n` +
                `Get my badge: ${claimUrl}\n\n` +
                `If Add to Web Wallet doesn't show your wallet, sign in to your wallet, choose Settings → Enable browser wallet, and open this link again.\n\n` +
                `This badge is for testing the alpha. It doesn't certify any skill or achievement.\n\n` +
                `${ORG_NAME} · Learner Credential Wallet`,
            },
            Html: {
              Data: emailHtml({
                title: "Your LCW Alpha Testing Badge is ready",
                paragraphs: [
                  `Hi ${escapeHtml(name)}, your LCW Alpha Testing Badge is ready. Open the link and choose Add to Web Wallet to add it to your Learner Credential Wallet.`,
                ],
                button: { label: "Get my badge", url: claimUrl },
                after:
                  `<p>If Add to Web Wallet doesn&#39;t show your wallet, sign in to your wallet, choose Settings &rarr; Enable browser wallet, and open this link again.</p>` +
                  `<p>This badge is for testing the alpha. It doesn&#39;t certify any skill or achievement.</p>`,
              }),
            },
          },
        },
      },
    })
  );
  return json(200, { sent: true });
}

async function createExchange(event) {
  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }
  // An emailed link's token, or the claim code typed into the page
  let token;
  if (body.token !== undefined) {
    const found = await loadToken(body.token);
    if (!found || found.used) {
      return json(403, { error: found ? "This link has already been used." : "This link isn't valid, or it has expired." });
    }
    token = found;
  } else if (!codeAccepted(body.code)) {
    return json(403, { error: body.code ? "That code isn't valid." : "A code is required." });
  }
  // The name to put on the badge: the one the link was made for, else the
  // one the page sends
  const holderName =
    token?.holderName ?? (typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME_LENGTH) : "");

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
        ...(token && { token: { S: token.token } }),
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
      query: [
        {
          type: "DIDAuthentication",
          // The holder DIDs this issuer verifies: a did:web (the wallet's
          // account projection, resolved over HTTPS) or a did:key.
          acceptedMethods: [{ method: "web" }, { method: "key" }],
        },
      ],
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
    token: Item.token?.S,
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
  // The badge is signed; before it is handed over, the link it came through
  // is used up (and with it the wallet account's one badge). A link or an
  // account that was used meanwhile gets nothing.
  if (exchange.token) {
    try {
      await useToken(exchange.token);
    } catch (err) {
      if (err.statusCode === 403) {
        return json(403, { error: err.message });
      }
      throw err;
    }
  }
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
