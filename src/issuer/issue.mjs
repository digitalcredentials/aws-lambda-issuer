import * as vc from "@digitalbazaar/vc";
import { Ed25519Signature2020 } from "@digitalbazaar/ed25519-signature-2020";
import { Ed25519VerificationKey2020 } from "@digitalbazaar/ed25519-verification-key-2020";
import { securityLoader } from "@digitalcredentials/security-document-loader";

// JSON-LD contexts beyond the loader's bundled set (the Open Badges context)
// are fetched over the network and cached for the life of the container.
export const documentLoader = securityLoader({ fetchRemoteContexts: true }).build();

let cachedSuite;

// The issuer's signing suite, derived once per container from ISSUER_SEED.
export async function issuerSuite() {
  if (!cachedSuite) {
    const seed = process.env.ISSUER_SEED;
    if (!/^[0-9a-f]{64}$/i.test(seed ?? "")) {
      throw new Error("ISSUER_SEED must be 64 hex characters");
    }
    const key = await Ed25519VerificationKey2020.generate({
      seed: new Uint8Array(Buffer.from(seed, "hex")),
    });
    const did = `did:key:${key.fingerprint()}`;
    key.controller = did;
    key.id = `${did}#${key.fingerprint()}`;
    cachedSuite = { suite: new Ed25519Signature2020({ key }), did };
  }
  return cachedSuite;
}

// The one credential this issuer knows how to issue: the LCW Sandbox Badge,
// bound to the holder DID the DIDAuth presentation proved control of. When
// the exchange carries the recipient's name (from the notification link), it
// goes on the credential subject.
export function badgeCredential({ issuerDid, holderDid, holderName }) {
  return {
    "@context": [
      "https://www.w3.org/ns/credentials/v2",
      "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.2.json",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    name: "LCW Sandbox Badge",
    issuer: {
      id: issuerDid,
      type: ["Profile"],
      name: "LCW Sandbox Issuer",
      url: process.env.COLLECTION_PAGE_URL ?? "https://issuer.lcw-sandbox.org",
    },
    validFrom: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    credentialSubject: {
      id: holderDid,
      type: ["AchievementSubject"],
      ...(holderName && { name: holderName }),
      achievement: {
        id: "urn:uuid:8asd10f3-2c6b-4b1e-9a05-lcwsandbox01",
        type: ["Achievement"],
        achievementType: "Badge",
        name: "LCW Sandbox Badge",
        description:
          "The holder claimed a credential from the LCW sandbox issuer over a CHAPI + VC API exchange.",
        criteria: {
          narrative:
            "Claimed via a DIDAuth-authenticated workflow exchange, proving control of the wallet DID this credential is bound to.",
        },
        image: {
          id: "https://digitalcredentials.github.io/badge-assets/lcw-exp.png",
          type: "Image",
        },
      },
    },
  };
}

// Verifies the wallet's DIDAuth presentation against the exchange's challenge
// and domain; returns the holder DID on success, throws on failure.
export async function verifyDidAuth({ presentation, challenge, domain }) {
  const result = await vc.verify({
    presentation,
    challenge,
    domain,
    suite: new Ed25519Signature2020(),
    documentLoader,
  });
  if (!result.verified) {
    const detail =
      result.error?.errors?.[0]?.message ?? result.error?.message ?? "not verified";
    throw Object.assign(new Error(`DIDAuth verification failed: ${detail}`), {
      statusCode: 400,
    });
  }
  const holderDid = presentation.holder;
  if (typeof holderDid !== "string" || !holderDid.startsWith("did:")) {
    throw Object.assign(new Error("Presentation carries no holder DID."), {
      statusCode: 400,
    });
  }
  return holderDid;
}

// Issues the badge to the holder: fills in the subject DID (and name, when
// the exchange carries one) and signs.
export async function issueBadge({ holderDid, holderName }) {
  const { suite, did } = await issuerSuite();
  const credential = badgeCredential({ issuerDid: did, holderDid, holderName });
  return vc.issue({ credential, suite, documentLoader });
}
