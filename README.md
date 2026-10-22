# aws-lambda-issuer

> [!WARNING]
> This is a throw-away repository, built for testing the LCW sandbox's
> issuance flow. It is not meant for long-term use: expect it to change
> without notice, be reset, or disappear entirely.

The LCW sandbox's **test issuer**, defined with
[AWS SAM](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html):
one Lambda that issues the on-demand LCW Sandbox Badge over a
[VCALM workflow exchange](https://www.w3.org/TR/vcalm-1.0/#workflows-and-exchanges),
and the S3+CloudFront-hosted React **claim page** wallets claim it from
([https://issuer.lcw-sandbox.org](https://issuer.lcw-sandbox.org)). The
wallet requests the badge as the welcome credential after registration, and
anyone can request it from the claim page.

The batch issuer that serves batches built in the wallet's Credential Issuer
screen is a separate service with its own collection page,
[batch-issuer-backend](https://github.com/digitalcredentials/batch-issuer-backend).
Nothing here depends on it.

## The badge exchange

One workflow, `lcw-sandbox-badge`:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/workflows/lcw-sandbox-badge/exchanges` | Create an exchange; returns its URL and the CHAPI-ready `verifiablePresentationRequest` (DIDAuthentication query, challenge, domain, and `interact.service` endpoints). An optional JSON body `{"name": "..."}` puts that name on the issued credential's subject |
| POST | `/workflows/lcw-sandbox-badge/exchanges/{exchangeId}` | Participate: an empty body gets the DIDAuthentication request; a body with `verifiablePresentation` gets verified and answered with the issued credential. The LCW mobile wallet's shape is also accepted, a bare signed presentation as the body (challenge only, no domain), answered with the bare presentation holding the credential |
| GET | `/workflows/lcw-sandbox-badge/exchanges/{exchangeId}` | The exchange's state |
| POST | `/workflows/lcw-sandbox-badge/notifications` | Send a claim email: `{"name", "email"}` → SES mails the address a link to the collection page with `?name=` attached |

The wallet proves control of a DID by signing a DIDAuth presentation over the
exchange's challenge and domain (Ed25519Signature2020). The DIDAuthentication
query states the holder DID methods the issuer verifies (`acceptedMethods`:
`web` and `key`), so the wallet answers with its account's `did:web`
projection (served by its identity domain and resolved here over HTTPS)
rather than a fresh `did:key` per credential. On success the badge
is issued with `credentialSubject.id` set to that DID, signed with the
issuer's seed-derived `did:key`
(`did:key:z6MkkCNaxehr7RoeDJQP39oQ1yFbmUg29ziXfLwoyeCo1QFf`), and returned
inside a presentation envelope, the exchange's final result. A completed
exchange replays its result idempotently; exchanges expire after 15 minutes
(DynamoDB TTL).

## The claim page

`collection-page/` is a small React app. Opened plain
(`https://issuer.lcw-sandbox.org`), it prompts for the name to put on the
badge: **Continue to claim** proceeds in this browser (writing `?name=` into
the URL), or an email address turns it into a mailed claim link, which the
notifications endpoint emails back to this page with the name as a `?name=`
query parameter. Opened with a name, it shows the badge card for that name
with two claim options, each creating an exchange (passing the name along, so
the issued credential's subject carries it): **Add to Web Wallet** hands the
presentation request to the user's wallet via [CHAPI](https://chapi.io/),
and **Add to Mobile Wallet** builds the
[Learner Credential Wallet app](https://github.com/openwallet-foundation-labs/learner-credential-wallet)'s
request deep link
(`https://lcw.app/request?issuer=…&vc_request_url=…&challenge=…&auth_type=bearer`),
shown as a QR code to scan plus a tappable link for phones. The CHAPI call
goes through `navigator.credentialsPolyfill.credentials.get` rather than
`navigator.credentials.get`, which password-manager extensions (e.g.
1Password) can lock; a call that reaches the native API throws "No credential
type was specified in the request". The page must be served over HTTPS (CHAPI
requires a secure context), which is why the template fronts the bucket with
CloudFront rather than S3 website hosting.

## Parameters

- **`IssuerSeed`** (NoEcho, required): 64-char hex seed for the issuer's
  Ed25519 key. Keep it stable: the derived `did:key` is what verifiers
  register (the LCW sandbox wallet lists it as *LCW Sandbox Issuer*).
- **`DomainName`** / **`CertificateArn`** / **`HostedZoneId`**: the claim
  page's domain (default `issuer.lcw-sandbox.org`), its ACM certificate, and
  the Route 53 zone the alias records go in.
- **`NotifyFromEmail`** / **`SesIdentity`**: the address claim emails are sent
  from (default `issuer@lcw-sandbox.org`) and the verified SES identity it
  sends under (default `lcw-sandbox.org`, the domain identity the
  lcw-back-end stack verified).

## Deploy

```bash
sam build
sam deploy --guided   # pass IssuerSeed; later deploys reuse it

cd collection-page
echo "VITE_EXCHANGE_API=<ExchangeApi output>" > .env.production
npm install && npm run build
aws s3 sync dist/ s3://<CollectionPageBucket output>/ --delete
aws cloudfront create-invalidation --distribution-id <CollectionPageDistributionId output> --paths "/*"
```

The `ExchangeApi` output is also the wallet's `VITE_ISSUER_API_BASE`.

## Test

```bash
cd src/issuer && npm install && npm test
```

Runs the whole exchange in-process with mocked AWS clients, playing the
wallet side with its own `did:key`: create → DIDAuthentication request → a
wrong challenge is rejected → a valid DIDAuth presentation gets the badge,
bound to the holder and signed by the seed-derived issuer DID → the
signature verifies → the completed exchange replays its result.

The lcw-front-end repo's `npm run test:claim` drives the same flow against
the deployed API using the wallet's own signing stack.
