import { useEffect, useState } from 'react'
import * as polyfill from 'credential-handler-polyfill'
import QRCode from 'qrcode'

// This stack's API (the ExchangeApi output), baked in at build time.
const API = (import.meta.env.VITE_EXCHANGE_API ?? '').replace(/\/+$/, '')
const WORKFLOW = 'lcw-sandbox-badge'
const BADGE_IMAGE = 'https://digitalcredentials.github.io/badge-assets/lcw-exp.png'
const BADGE_NAME = 'LCW Alpha Testing Badge'

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh', margin: 0, background: '#f9fafb', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    fontFamily: 'system-ui, -apple-system, sans-serif'
  },
  card: {
    width: '100%', maxWidth: 420, background: '#fff', borderRadius: 16,
    boxShadow: '0 4px 12px rgba(0,0,0,.08)', padding: 32, textAlign: 'center'
  },
  image: { width: 120, height: 120, objectFit: 'contain' },
  label: {
    display: 'block', textAlign: 'left', fontSize: 13, fontWeight: 600,
    color: '#374151', margin: '14px 0 4px'
  },
  input: {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 14,
    border: '1px solid #d1d5db', borderRadius: 8
  },
  button: {
    marginTop: 20, width: '100%', padding: '12px 16px', border: 0,
    borderRadius: 10, background: '#4f46e5', color: '#fff', fontSize: 15,
    fontWeight: 600, cursor: 'pointer'
  },
  secondaryButton: {
    marginTop: 10, width: '100%', padding: '12px 16px',
    border: '1px solid #d1d5db', borderRadius: 10, background: '#fff',
    color: '#374151', fontSize: 15, fontWeight: 600, cursor: 'pointer'
  },
  divider: { margin: '22px 0 4px', fontSize: 12, color: '#9ca3af', textTransform: 'uppercase' },
  note: { marginTop: 14, fontSize: 13, color: '#6b7280' },
  error: {
    marginTop: 14, fontSize: 13, color: '#b91c1c', background: '#fef2f2',
    border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px'
  },
  success: {
    marginTop: 14, fontSize: 13, color: '#15803d', background: '#f0fdf4',
    border: '1px solid #bbf7d0', borderRadius: 8, padding: '8px 12px'
  }
}

// A claim link (from the notification email) carries the recipient's name
// and a token that is good for one badge; without a token, the page asks
// for the name and the code first.
const urlParams = new URLSearchParams(window.location.search)
const urlName = urlParams.get('name')?.trim() ?? ''
const urlToken = urlParams.get('token')?.trim() ?? ''

// What lets a badge be issued: the emailed link's token, or the code typed
// into the form
type Access = { token: string } | { code: string }
interface Claim {
  name: string
  access: Access
}

// The issuer's own sentence for a refusal, when it gave one
async function refusalOf(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}))
  return typeof body.error === 'string' && body.error ? body.error : fallback
}

// Prompt for the name the credential should be issued to. Continue claims in
// this browser; alternatively, an email address turns it into a mailed claim
// link for someone else.
function NamePrompt({ onContinue }: { onContinue: (claim: Claim) => void }) {
  const [name, setName] = useState(urlName)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [nameError, setNameError] = useState('')
  const [emailError, setEmailError] = useState('')
  const [sentTo, setSentTo] = useState('')

  // Both actions need a name; only the email action needs a (valid) address.
  // Same address shape the issuer enforces server-side.
  function requireName(): boolean {
    if (!name.trim()) {
      setNameError('Please enter the name to which to issue the credential.')
      document.getElementById('recipient-name')?.focus()
      return false
    }
    setNameError('')
    return true
  }

  function requireCode(): boolean {
    if (!code.trim()) {
      setCodeError('Please enter your code.')
      return false
    }
    setCodeError('')
    return true
  }

  // The code is checked by the issuer when the badge is asked for
  function continueToClaim() {
    const nameOk = requireName()
    if (requireCode() && nameOk) {
      onContinue({ name: name.trim(), access: { code: code.trim() } })
    }
  }

  async function sendEmail() {
    const nameOk = requireName() && requireCode()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError('Please enter a valid email address to which to send the claim link.')
      if (nameOk) {
        document.getElementById('recipient-email')?.focus()
      }
      return
    }
    setEmailError('')
    if (!nameOk) {
      return
    }

    setBusy(true)
    setError('')
    setSentTo('')
    try {
      const res = await fetch(`${API}/workflows/${WORKFLOW}/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), code: code.trim() })
      })
      if (!res.ok) {
        throw new Error(await refusalOf(res, `The link could not be sent (${res.status}).`))
      }
      setSentTo(email.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.card}>
      <img style={styles.image} src={BADGE_IMAGE} alt={BADGE_NAME} />
      <h1 style={{ fontSize: 22, margin: '12px 0 4px' }}>{BADGE_NAME}</h1>
      <p style={{ fontSize: 14, color: '#4b5563', margin: 0 }}>
        Whose name should go on the badge?
      </p>
      <label style={styles.label} htmlFor="recipient-name">Name on the badge</label>
      <input
        id="recipient-name"
        style={styles.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ada Lovelace"
        maxLength={100}
      />
      {nameError && <p role="alert" style={styles.error}>{nameError}</p>}
      <label style={styles.label} htmlFor="claim-code">Code</label>
      <input
        id="claim-code"
        style={styles.input}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Your code"
        autoComplete="off"
        maxLength={100}
      />
      {codeError && <p role="alert" style={styles.error}>{codeError}</p>}
      <button
        style={styles.button}
        onClick={continueToClaim}
        disabled={busy}
      >
        Continue to claim
      </button>

      <p style={styles.divider} aria-hidden="true">or email a claim link</p>
      <label style={styles.label} htmlFor="recipient-email">Email to notify</label>
      <input
        id="recipient-email"
        style={styles.input}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="ada@example.com"
      />
      {emailError && <p role="alert" style={styles.error}>{emailError}</p>}
      <button
        style={styles.secondaryButton}
        onClick={sendEmail}
        disabled={busy}
      >
        {busy ? 'Sending…' : 'Send the link'}
      </button>
      {sentTo && (
        <p style={styles.success}>
          Sent. Check {sentTo} for a link to get the badge.
        </p>
      )}
      {error && <p style={styles.error}>{error}</p>}
      <p style={styles.note}>
        Either way, the badge carries the name you enter and goes into the
        wallet you add it to.
      </p>
    </div>
  )
}

// The claim card for a name: the CHAPI and QR flows both use the exchange
// URL the server returns.
function ClaimCard({ request, onRefused }: { request: Claim; onRefused: () => void }) {
  const { name, access } = request
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [mobile, setMobile] = useState<{ link: string; qr: string; exchangeUrl: string } | null>(null)

  // Whether the issuer has issued the badge for an exchange: the page says
  // the badge was added only when this is so, whatever the wallet returned
  async function exchangeComplete(exchangeUrl: string): Promise<boolean> {
    const res = await fetch(exchangeUrl)
    return res.ok && (await res.json()).state === 'complete'
  }

  // The mobile app finishes the claim on the phone, so while its QR code is
  // shown the page asks the issuer every few seconds whether it is done
  useEffect(() => {
    if (!mobile || done) {
      return
    }
    const timer = setInterval(() => {
      exchangeComplete(mobile.exchangeUrl).then((complete) => {
        if (complete) {
          setDone(true)
        }
      }, () => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [mobile, done])

  async function createExchange() {
    const res = await fetch(`${API}/workflows/${WORKFLOW}/exchanges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...access })
    })
    if (!res.ok) {
      throw new Error(await refusalOf(res, `The issuer could not start an exchange (${res.status}).`))
    }
    return res.json()
  }

  // The mobile LCW app claims through its request deep link: it signs a
  // DIDAuth presentation over the challenge and POSTs it to vc_request_url.
  async function addToMobileWallet() {
    setBusy(true)
    setError('')
    setMobile(null)
    try {
      const { id, verifiablePresentationRequest } = await createExchange()
      const link =
        'https://lcw.app/request' +
        `?issuer=${encodeURIComponent(window.location.origin)}` +
        `&vc_request_url=${encodeURIComponent(id)}` +
        `&challenge=${encodeURIComponent(verifiablePresentationRequest.challenge)}` +
        '&auth_type=bearer'
      const qr = await QRCode.toDataURL(link, { width: 220, margin: 1 })
      setMobile({ link, qr, exchangeUrl: id })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function claim() {
    setBusy(true)
    setError('')
    setDone(false)

    try {
      // CHAPI: lets the user pick their wallet
      await polyfill.loadOnce()

      // A fresh exchange for this claim; its request carries the challenge,
      // domain, and the exchange URL the wallet interacts with.
      const { id: exchangeUrl, verifiablePresentationRequest } = await createExchange()

      // Call the CHAPI polyfill's container directly: password-manager
      // extensions (e.g. 1Password) can lock navigator.credentials.get, in
      // which case a call to it reaches the NATIVE API instead, which throws
      // "No credential type was specified in the request".
      const credentials =
        (navigator as unknown as { credentialsPolyfill?: { credentials: CredentialsContainer } })
          .credentialsPolyfill?.credentials ?? navigator.credentials
      const result = await credentials.get({
        web: { VerifiablePresentation: verifiablePresentationRequest }
      } as CredentialRequestOptions)

      if (!result) {
        setError('Wallet selection was cancelled.')
        return
      }
      // The wallet returned something; the claim is finished only if the
      // issuer has issued the badge
      if (!(await exchangeComplete(exchangeUrl))) {
        setError("The badge wasn't added. Please try again.")
        return
      }
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.card}>
      <img style={styles.image} src={BADGE_IMAGE} alt={BADGE_NAME} />
      <h1 style={{ fontSize: 22, margin: '12px 0 4px' }}>{BADGE_NAME}</h1>
      {!done && (
        <p style={{ fontSize: 14, color: '#4b5563', margin: 0 }}>
          A badge for <strong>{name}</strong> is ready. Add it to your Learner
          Credential Wallet.
        </p>
      )}
      {!done && (
        <>
          <button style={styles.button} onClick={claim} disabled={busy}>
            {busy ? 'Working…' : 'Add to Web Wallet'}
          </button>
          <button style={styles.secondaryButton} onClick={addToMobileWallet} disabled={busy}>
            Add to Mobile Wallet
          </button>
        </>
      )}
      {mobile && !done && (
        <div style={{ marginTop: 14 }}>
          <img src={mobile.qr} alt="QR code for the mobile claim link" style={{ width: 180, height: 180 }} />
          <p style={{ ...styles.note, marginTop: 4 }}>
            Scan with your phone&#39;s camera, or if you&#39;re reading this on
            your phone,{' '}
            <a href={mobile.link} style={{ color: '#4f46e5' }}>
              open it in the Learner Credential Wallet app
            </a>
            . The link is valid for 15 minutes.
          </p>
        </div>
      )}
      {done && (
        <p style={styles.success}>
          Your badge has been added. Open your wallet to see it.
        </p>
      )}
      {!done && error && <p style={styles.error}>{error}</p>}
      {!done && error && 'code' in access && (
        <button style={styles.secondaryButton} onClick={onRefused}>
          Enter the code again
        </button>
      )}
      {!done && (
        <p style={styles.note}>
          Add to Web Wallet needs your wallet enabled in this browser. If you
          haven&#39;t done that yet, sign in to your wallet and choose Settings →
          Enable browser wallet. Add to Mobile Wallet opens the{' '}
          <a href="https://lcw.app" style={{ color: '#4f46e5' }}>Learner Credential Wallet app</a>.
        </p>
      )}
    </div>
  )
}

export default function App() {
  // An emailed link opens the claim card at once; anything else starts at
  // the form, since a badge needs the link's token or the code
  const [claim, setClaim] = useState<Claim | null>(urlName && urlToken ? { name: urlName, access: { token: urlToken } } : null)

  return (
    <div style={styles.page}>
      {claim ? (
        <ClaimCard request={claim} onRefused={() => setClaim(null)} />
      ) : (
        <NamePrompt onContinue={setClaim} />
      )}
    </div>
  )
}
