import * as vc from "@digitalbazaar/vc";
import { Ed25519Signature2020 } from "@digitalbazaar/ed25519-signature-2020";
import { Ed25519VerificationKey2020 } from "@digitalbazaar/ed25519-verification-key-2020";
import { securityLoader } from "@digitalcredentials/security-document-loader";

// JSON-LD contexts beyond the loader's bundled set are fetched over the
// network and cached for the life of the container.
export const documentLoader = securityLoader({ fetchRemoteContexts: true }).build();

// A signing suite derived from a batch's seed (as staged in the credential
// bundle by the notify lambda). Deliberately uncached: each exchange carries
// its own batch's seed, unlike the badge issuer's single ISSUER_SEED suite.
export async function suiteFromSeed(seedHex) {
  if (!/^[0-9a-f]{64}$/i.test(seedHex ?? "")) {
    throw new Error("Bundle seed must be 64 hex characters");
  }
  const key = await Ed25519VerificationKey2020.generate({
    seed: new Uint8Array(Buffer.from(seedHex, "hex")),
  });
  const did = `did:key:${key.fingerprint()}`;
  key.controller = did;
  key.id = `${did}#${key.fingerprint()}`;
  return { suite: new Ed25519Signature2020({ key }), did };
}

// Signs a populated credential with the batch's seed. Verifiers require the
// credential's issuer id to equal the signing key's controller, so the batch
// DID becomes issuer.id; the issuer's web address (which the template put in
// issuer.id) moves to issuer.url. vc.issue appends the ed25519-2020 suite
// context to @context when it is missing.
export async function signCredential({ credential, seedHex }) {
  const { suite, did } = await suiteFromSeed(seedHex);
  const issuer = typeof credential.issuer === "object" && credential.issuer !== null
    ? credential.issuer
    : {};
  const issuerUrl = issuer.url ?? issuer.id;
  credential.issuer = {
    ...issuer,
    id: did,
    ...(issuerUrl && issuerUrl !== did && { url: issuerUrl }),
  };
  return vc.issue({ credential, suite, documentLoader });
}

// Verifies the wallet's DIDAuth presentation against the exchange's challenge
// and domain; returns the holder DID on success, throws on failure. The LCW
// mobile wallet signs over the challenge alone, so the domain is enforced
// only when the presentation's proof carries one. (Same behavior as the badge
// issuer's src/issuer/issue.mjs; copied because each function's CodeUri is
// packaged separately.)
export async function verifyDidAuth({ presentation, challenge, domain }) {
  const proofs = [presentation?.proof ?? []].flat();
  const proofHasDomain = proofs.some((p) => p?.domain);
  const result = await vc.verify({
    presentation,
    challenge,
    ...(proofHasDomain && { domain }),
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
