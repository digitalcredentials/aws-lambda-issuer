// Local test for the issuer: drives a complete VCALM exchange in-process with
// a mocked DynamoDB, playing the wallet side with its own did:key, and
// verifies the issued credential's signature.
//
//   cd src/issuer && npm install && npm test
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import * as vc from "@digitalbazaar/vc";
import { Ed25519Signature2020 } from "@digitalbazaar/ed25519-signature-2020";
import { Ed25519VerificationKey2020 } from "@digitalbazaar/ed25519-verification-key-2020";

process.env.ISSUER_SEED = "5b".repeat(32);
process.env.TABLE_NAME = "exchanges-test";
process.env.COLLECTION_PAGE_URL = "https://issuer.example.com";
process.env.NOTIFY_FROM_EMAIL = "issuer@example.com";
process.env.CLAIM_CODE = "TEST-CODE";
process.env.WALLET_API_BASE = "https://api.example.com";
const CODE = "TEST-CODE";

// The wallet's back end, as the issuer reaches it: one account's grant,
// good until it is used. Every other request (JSON-LD contexts) goes out.
const GRANT = "Z3JhY2VAZXhhbXBsZS5jb20.grant-secret";
let grantCollected = false;
const grantCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://api.example.com/")) {
        return realFetch(url, init);
    }
    const { grant, consume } = JSON.parse(init.body);
    grantCalls.push({ grant, consume });
    const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (grant !== GRANT) return answer(404, { valid: false });
    if (grantCollected) return answer(409, { valid: false, collected: true });
    if (consume) grantCollected = true;
    return answer(200, { valid: true });
};

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
    if (input.UpdateExpression.includes("usedAt")) {
        // A link's token, used once
        if (!item || item.usedAt) {
            throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
        }
        item.usedAt = input.ExpressionAttributeValues[":now"];
        return {};
    }
    item.state = input.ExpressionAttributeValues[":complete"];
    item.result = input.ExpressionAttributeValues[":result"];
    return {};
});

const sesMock = mockClient(SESv2Client);
const sentEmails = [];
sesMock.on(SendEmailCommand).callsFake((input) => {
    sentEmails.push(input);
    return { MessageId: "test-message" };
});

const event = ({ exchangeId, body, method = "POST", workflowId = "lcw-sandbox-badge", path } = {}) => ({
    pathParameters: { workflowId, ...(exchangeId && { exchangeId }) },
    rawPath: path ?? `/workflows/${workflowId}/exchanges${exchangeId ? `/${exchangeId}` : ""}`,
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

// 2. create an exchange, carrying the recipient name from the claim link
const HOLDER_NAME = "Ada Lovelace";
res = await lambdaHandler(event({ body: JSON.stringify({ name: HOLDER_NAME, code: CODE }) }));
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
check("credentialSubject.name is the notified name", credential?.credentialSubject?.name === HOLDER_NAME);
check("issuer is the seed-derived DID", credential?.issuer?.id === issuerDid);
// The issuer the badge names (issue #22)
check("the badge names its issuer Digital Credentials Commons",
    credential?.issuer?.name === "Digital Credentials Commons" && credential?.issuer?.url === "https://dccommons.org");
// The badge's wording (issue #18), and the words it must not carry
const achievement = credential?.credentialSubject?.achievement;
const FORBIDDEN = /sandbox|\bDID\b|CHAPI|VC API|DIDAuth/i;
check("the badge is named LCW Alpha Testing Badge", credential?.name === "LCW Alpha Testing Badge" &&
    achievement?.name === "LCW Alpha Testing Badge");
check("the badge carries the agreed description and criteria",
    achievement?.description === "Issued to people who tested the Learner Credential Wallet alpha. It doesn't certify any skill, course or achievement." &&
    achievement?.criteria?.narrative === "Claimed into a Learner Credential Wallet during the alpha.");
check("the badge's name, issuer, description, criteria and achievement id avoid the excluded words",
    !FORBIDDEN.test([credential?.name, credential?.issuer?.name, credential?.issuer?.url, achievement?.name, achievement?.description, achievement?.criteria?.narrative, achievement?.id].join(" ")));

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

// 10. an exchange created without a name issues a nameless subject
res = await lambdaHandler(event({ body: JSON.stringify({ code: CODE }) }));
const unnamed = JSON.parse(res.body);
res = await lambdaHandler(event({ exchangeId: unnamed.exchangeId, body: JSON.stringify({
    verifiablePresentation: await vc.signPresentation({
        presentation: vc.createPresentation({ holder: holderDid }),
        suite: new Ed25519Signature2020({ key: holderKey }),
        challenge: unnamed.verifiablePresentationRequest.challenge,
        domain: unnamed.verifiablePresentationRequest.domain,
        documentLoader,
    }),
}) }));
const namelessCred = JSON.parse(res.body).verifiablePresentation?.verifiableCredential?.[0];
check("nameless exchange -> subject has no name", res.statusCode === 200 &&
    namelessCred && !("name" in namelessCred.credentialSubject));

// 11. the notification endpoint sends the claim email
const notifyPath = "/workflows/lcw-sandbox-badge/notifications";
res = await lambdaHandler(event({ path: notifyPath, body: JSON.stringify({
    name: "Grace Hopper", email: "grace@example.com", code: CODE,
}) }));
const sent = sentEmails[0];
check("notify -> 200 and SES send", res.statusCode === 200 && sentEmails.length === 1);
check("email goes to the given address from NOTIFY_FROM_EMAIL",
    sent?.Destination?.ToAddresses?.[0] === "grace@example.com" &&
    sent?.FromEmailAddress === "issuer@example.com");
check("email links to the collection page with the encoded name",
    sent?.Content?.Simple?.Body?.Text?.Data?.includes(
        "https://issuer.example.com/?name=Grace%20Hopper") ?? false);

const emailText = sent?.Content?.Simple?.Body?.Text?.Data ?? "";
const linkToken = emailText.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1];
check("the emailed link carries a token", Boolean(linkToken) && store.has(`token#${linkToken}`));
const emailHtmlBody = sent?.Content?.Simple?.Body?.Html?.Data ?? "";
check("the email's subject is the agreed one",
    sent?.Content?.Simple?.Subject?.Data === "Your LCW Alpha Testing Badge is ready");
check("the plain-text email carries the agreed wording", emailText ===
    "Hi Grace Hopper, your LCW Alpha Testing Badge is ready. Open the link and choose Add to Web Wallet to add it to your Learner Credential Wallet.\n\n" +
    `Get my badge: https://issuer.example.com/?name=Grace%20Hopper&token=${linkToken}\n\n` +
    "If Add to Web Wallet doesn't show your wallet, sign in to your wallet, choose Settings → Enable browser wallet, and open this link again.\n\n" +
    "This badge is for testing the alpha. It doesn't certify any skill or achievement.\n\n" +
    "Digital Credentials Commons · Learner Credential Wallet");
check("the HTML email has the Get my badge button and the same sentences",
    emailHtmlBody.includes(">Get my badge</a>") &&
    emailHtmlBody.includes("Hi Grace Hopper, your LCW Alpha Testing Badge is ready.") &&
    emailHtmlBody.includes("This badge is for testing the alpha.") &&
    emailHtmlBody.includes("Digital Credentials Commons &middot; Learner Credential Wallet"));
check("the email avoids the excluded words",
    !FORBIDDEN.test(emailText) && !FORBIDDEN.test(emailHtmlBody.replace(/<[^>]+>/g, " ")));

// 12. notification validation
res = await lambdaHandler(event({ path: notifyPath, body: JSON.stringify({ name: "", email: "grace@example.com", code: CODE }) }));
check("notify without a name -> 400", res.statusCode === 400);
res = await lambdaHandler(event({ path: notifyPath, body: JSON.stringify({ name: "Grace", email: "not-an-email", code: CODE }) }));
check("notify with a bad email -> 400", res.statusCode === 400);
check("invalid notifications sent nothing", sentEmails.length === 1);

// 13. the LCW mobile wallet's shape: a bare VP signed over the challenge only
// (no domain), answered with the bare presentation holding the credential
res = await lambdaHandler(event({ body: JSON.stringify({ name: HOLDER_NAME, code: CODE }) }));
const mobileExchange = JSON.parse(res.body);
const mobileVp = await vc.signPresentation({
    presentation: vc.createPresentation({ holder: holderDid }),
    suite: new Ed25519Signature2020({ key: holderKey }),
    challenge: mobileExchange.verifiablePresentationRequest.challenge,
    documentLoader,
});
res = await lambdaHandler(event({ exchangeId: mobileExchange.exchangeId, body: JSON.stringify(mobileVp) }));
const mobileResult = JSON.parse(res.body);
const mobileCred = mobileResult?.verifiableCredential?.[0];
check("bare VP without domain -> 200 with bare VP result", res.statusCode === 200 &&
    [mobileResult?.type ?? []].flat().includes("VerifiablePresentation") &&
    !("verifiablePresentation" in mobileResult) && !!mobileCred);
check("mobile-claimed credential is bound to the holder with the name",
    mobileCred?.credentialSubject?.id === holderDid &&
    mobileCred?.credentialSubject?.name === HOLDER_NAME);
res = await lambdaHandler(event({ exchangeId: mobileExchange.exchangeId, body: JSON.stringify(mobileVp) }));
check("completed mobile exchange replays the bare shape", res.statusCode === 200 &&
    JSON.parse(res.body)?.verifiableCredential?.[0]?.id === mobileCred.id);

// 14. a wrong challenge still fails without a domain
const badMobileVp = await vc.signPresentation({
    presentation: vc.createPresentation({ holder: holderDid }),
    suite: new Ed25519Signature2020({ key: holderKey }),
    challenge: "not-the-challenge",
    documentLoader,
});
res = await lambdaHandler(event({ body: JSON.stringify({ code: CODE }) }));
const mobileExchange2 = JSON.parse(res.body);
res = await lambdaHandler(event({ exchangeId: mobileExchange2.exchangeId, body: JSON.stringify(badMobileVp) }));
check("bare VP with the wrong challenge -> 400", res.statusCode === 400);

// 15. who may have the badge (issue 27): a code, a wallet account's grant,
// or the token of an emailed link
const post = (path, body) => lambdaHandler(event({ ...(path && { path }), body: JSON.stringify(body) }));
// Plays the wallet through an exchange made with `body`; resolves the answer to the signed presentation
async function claimWith(body) {
    const made = await post(undefined, body);
    if (made.statusCode !== 201) return made;
    const exchange = JSON.parse(made.body);
    const vp = await vc.signPresentation({
        presentation: vc.createPresentation({ holder: holderDid }),
        suite: new Ed25519Signature2020({ key: holderKey }),
        challenge: exchange.verifiablePresentationRequest.challenge,
        domain: exchange.verifiablePresentationRequest.domain,
        documentLoader,
    });
    return lambdaHandler(event({ exchangeId: exchange.exchangeId, body: JSON.stringify({ verifiablePresentation: vp }) }));
}
const errorOf = (r) => JSON.parse(r.body).error;
const emailsBefore = sentEmails.length;

res = await post(undefined, { name: "Nobody" });
check("an exchange with no code and no token -> 403", res.statusCode === 403 && errorOf(res) === "A code is required.");
res = await post(undefined, { name: "Nobody", code: "WRONG" });
check("an exchange with a wrong code -> 403", res.statusCode === 403 && errorOf(res) === "That code isn't valid.");
res = await post(undefined, { token: "x".repeat(32) });
check("an exchange with an unknown token -> 403", res.statusCode === 403);
res = await post(notifyPath, { name: "Nobody", email: "nobody@example.com" });
check("a notification with no code and no grant -> 403, nothing sent", res.statusCode === 403 && sentEmails.length === emailsBefore);
res = await post(notifyPath, { name: "Nobody", email: "nobody@example.com", code: "WRONG" });
check("a notification with a wrong code -> 403, nothing sent", res.statusCode === 403 && sentEmails.length === emailsBefore);
res = await post(notifyPath, { name: "Nobody", email: "nobody@example.com", grant: "not-a-grant" });
check("a notification with a grant the wallet's back end does not know -> 403, nothing sent", res.statusCode === 403 && sentEmails.length === emailsBefore);

// The link emailed for a code: one badge
res = await claimWith({ token: linkToken });
const linked = JSON.parse(res.body).verifiablePresentation?.verifiableCredential?.[0];
check("the emailed link's token gets the badge, in the name the link was made for", res.statusCode === 200 && linked?.credentialSubject?.name === "Grace Hopper");
res = await post(undefined, { token: linkToken });
check("the same link a second time -> 403", res.statusCode === 403 && errorOf(res) === "This link has already been used.");

// A wallet account: the grant is checked for the email and used when the badge is issued
res = await post(notifyPath, { name: "Ada Lovelace", email: "ada@example.com", grant: GRANT });
const walletToken = sentEmails.at(-1)?.Content?.Simple?.Body?.Text?.Data?.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1];
check("a wallet account's grant sends the email, and is not used yet", res.statusCode === 200 && Boolean(walletToken) && grantCollected === false && grantCalls.at(-1)?.consume === false);
res = await post(notifyPath, { name: "Ada Lovelace", email: "ada@example.com", grant: GRANT });
const secondToken = sentEmails.at(-1)?.Content?.Simple?.Body?.Text?.Data?.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1];
check("the account can ask for the email again before collecting", res.statusCode === 200 && secondToken !== walletToken);
// Two exchanges opened from the two links before either is finished
const openFirst = JSON.parse((await post(undefined, { token: walletToken })).body);
res = await claimWith({ token: secondToken });
check("the wallet account collects its badge, and the grant is used", res.statusCode === 200 && grantCollected === true && grantCalls.at(-1)?.consume === true);
const lateVp = await vc.signPresentation({
    presentation: vc.createPresentation({ holder: holderDid }),
    suite: new Ed25519Signature2020({ key: holderKey }),
    challenge: openFirst.verifiablePresentationRequest.challenge,
    domain: openFirst.verifiablePresentationRequest.domain,
    documentLoader,
});
res = await lambdaHandler(event({ exchangeId: openFirst.exchangeId, body: JSON.stringify({ verifiablePresentation: lateVp }) }));
check("the account's other link gets no second badge -> 403", res.statusCode === 403 && errorOf(res) === "This wallet account has already collected its badge." && !res.body.includes("verifiableCredential"));
res = await post(notifyPath, { name: "Ada Lovelace", email: "ada@example.com", grant: GRANT });
check("an account that has collected cannot ask for another email -> 403", res.statusCode === 403 && errorOf(res) === "This wallet account has already collected its badge.");

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
