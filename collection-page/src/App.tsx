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
  button: {
    marginTop: 20, width: '100%', padding: '12px 16px', border: 0,
    borderRadius: 10, background: '#4f46e5', color: '#fff', fontSize: 15,
    fontWeight: 600, cursor: 'pointer'
  },
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

export default function App() {
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
      // domain, and the exchange URL the wallet interacts with
      const res = await fetch(`${API}/workflows/${WORKFLOW}/exchanges`, { method: 'POST' })
      if (!res.ok) {
        throw new Error(`The issuer could not start an exchange (${res.status}).`)
      }
      const { verifiablePresentationRequest } = await res.json()

      const result = await navigator.credentials.get({
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
    <div style={styles.page}>
      <div style={styles.card}>
        <img
          style={styles.image}
          src="https://digitalcredentials.github.io/badge-assets/lcw-exp.png"
          alt="LCW Sandbox Badge"
        />
        <h1 style={{ fontSize: 22, margin: '12px 0 4px' }}>LCW Sandbox Badge</h1>
        <p style={{ fontSize: 14, color: '#4b5563', margin: 0 }}>
          Claim this badge into your Learner Credential Wallet. Your wallet
          proves control of a DID, and the credential is issued to it.
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
    </div>
  )
}
