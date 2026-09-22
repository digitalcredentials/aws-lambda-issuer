import { useState } from 'react'
import * as polyfill from 'credential-handler-polyfill'

const API = (import.meta.env.VITE_EXCHANGE_API ?? '').replace(/\/+$/, '')
const WORKFLOW = 'lcw-sandbox-badge'

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

// A claim link (from the notification email) carries the recipient's name;
// without one, the page prompts for it first.
const urlName = new URLSearchParams(window.location.search).get('name')?.trim() ?? ''

// Prompt for the name the credential should be issued to. Continue claims in
// this browser; alternatively, an email address turns it into a mailed claim
// link for someone else.
function NamePrompt({ onContinue }: { onContinue: (name: string) => void }) {
  const [name, setName] = useState('')
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
      setNameError('Please enter the name to issue the credential to.')
      document.getElementById('recipient-name')?.focus()
      return false
    }
    setNameError('')
    return true
  }

  function continueToClaim() {
    if (requireName()) {
      onContinue(name.trim())
    }
  }

  async function sendEmail() {
    const nameOk = requireName()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError('Please enter a valid email address to send the claim link to.')
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
        body: JSON.stringify({ name: name.trim(), email: email.trim() })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `The notification could not be sent (${res.status}).`)
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
      <img
        style={styles.image}
        src="https://digitalcredentials.github.io/badge-assets/lcw-exp.png"
        alt="LCW Sandbox Badge"
      />
      <h1 style={{ fontSize: 22, margin: '12px 0 4px' }}>LCW Sandbox Badge</h1>
      <p style={{ fontSize: 14, color: '#4b5563', margin: 0 }}>
        Whose name should go on the credential?
      </p>
      <label style={styles.label} htmlFor="recipient-name">Name on the credential</label>
      <input
        id="recipient-name"
        style={styles.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ada Lovelace"
        maxLength={100}
      />
      {nameError && <p role="alert" style={styles.error}>{nameError}</p>}
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
        {busy ? 'Sending…' : 'Send claim email'}
      </button>
      {sentTo && (
        <p style={styles.success}>
          Sent! {sentTo} has been emailed a link to claim the badge.
        </p>
      )}
      {error && <p style={styles.error}>{error}</p>}
      <p style={styles.note}>
        Either way, the credential is issued to that name and bound to the
        claimer&#39;s wallet DID.
      </p>
    </div>
  )
}

function ClaimCard({ claimName }: { claimName: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function claim() {
    setBusy(true)
    setError('')
    setDone(false)

    try {
      // CHAPI: lets the user pick their wallet
      await polyfill.loadOnce()

      // A fresh exchange for this claim; its request carries the challenge,
      // domain, and the exchange URL the wallet interacts with. The name
      // rides along so the issued credential carries it.
      const res = await fetch(`${API}/workflows/${WORKFLOW}/exchanges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: claimName })
      })
      if (!res.ok) {
        throw new Error(`The issuer could not start an exchange (${res.status}).`)
      }
      const { verifiablePresentationRequest } = await res.json()

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
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.card}>
      <img
        style={styles.image}
        src="https://digitalcredentials.github.io/badge-assets/lcw-exp.png"
        alt="LCW Sandbox Badge"
      />
      <h1 style={{ fontSize: 22, margin: '12px 0 4px' }}>LCW Sandbox Badge</h1>
      <p style={{ fontSize: 14, color: '#4b5563', margin: 0 }}>
        A badge for <strong>{claimName}</strong> is ready. Claim it into your
        Learner Credential Wallet: your wallet proves control of a DID, and the
        credential is issued to it in your name.
      </p>
      <button style={styles.button} onClick={claim} disabled={busy}>
        {busy ? 'Waiting for your wallet…' : 'Add to Wallet'}
      </button>
      {done && (
        <p style={styles.success}>
          Credential claimed! Check your wallet.
        </p>
      )}
      {error && <p style={styles.error}>{error}</p>}
      <p style={styles.note}>
        Uses CHAPI for wallet selection and a Verifiable Credential API
        exchange for issuance. Register your wallet with the browser first
        (in the LCW sandbox, use “Enable browser wallet”).
      </p>
    </div>
  )
}

export default function App() {
  const [claimName, setClaimName] = useState(urlName)

  function continueToClaim(name: string) {
    // Keep the name in the URL so a refresh stays on the claim card
    const url = new URL(window.location.href)
    url.searchParams.set('name', name)
    window.history.replaceState(null, '', url)
    setClaimName(name)
  }

  return (
    <div style={styles.page}>
      {claimName ? <ClaimCard claimName={claimName} /> : <NamePrompt onContinue={continueToClaim} />}
    </div>
  )
}
