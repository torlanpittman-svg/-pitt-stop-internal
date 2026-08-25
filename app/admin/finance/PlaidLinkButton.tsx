'use client'

/**
 * Read-only Plaid Link launcher (admin). Fetches a link token from our server, opens Plaid's
 * hosted Link/OAuth UI (bank credentials go ONLY to Plaid), and on success sends the short-lived
 * public token to our server to exchange + store (encrypted). Handles the OAuth redirect return.
 * No bank credentials ever touch our app; nothing here can move money.
 */
import { useCallback, useEffect, useState } from 'react'

declare global { interface Window { Plaid?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any

const SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
const LS_KEY = 'ps_plaid_link_token'

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Plaid) return resolve()
    const s = document.createElement('script'); s.src = SCRIPT; s.onload = () => resolve(); s.onerror = () => reject(new Error('Plaid script failed to load'))
    document.head.appendChild(s)
  })
}

export default function PlaidLinkButton() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const open = useCallback(async (token: string, receivedRedirectUri?: string) => {
    await loadScript()
    const handler = window.Plaid.create({
      token,
      ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess: async (publicToken: string) => {
        setBusy(true); setMsg('Linking… fetching accounts')
        try {
          const r = await fetch('/api/admin/finance/plaid/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public_token: publicToken }) })
          const d = await r.json()
          localStorage.removeItem(LS_KEY)
          if (!r.ok || !d.ok) { setMsg(d.error ?? 'Exchange failed'); setBusy(false); return }
          setMsg(`Connected ${d.institution ?? ''} · ${d.accounts} account(s). Reloading…`)
          // Drop any ?oauth_state_id from the URL and reload to render discovered accounts.
          window.location.href = window.location.pathname
        } catch { setMsg('Network error during exchange'); setBusy(false) }
      },
      onExit: (err: any) => { if (err) setMsg(err.display_message || err.error_message || 'Link closed'); localStorage.removeItem(LS_KEY) },
    })
    handler.open()
  }, [])

  // OAuth return: Plaid redirected back with ?oauth_state_id=… → resume with the stored token.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.location.search.includes('oauth_state_id')) {
      const token = localStorage.getItem(LS_KEY)
      if (token) open(token, window.location.href).catch((e) => setMsg(String(e)))
    }
  }, [open])

  const connect = useCallback(async () => {
    setBusy(true); setMsg('Preparing secure connection…')
    try {
      const r = await fetch('/api/admin/finance/plaid/link-token', { method: 'POST' })
      const d = await r.json()
      if (!r.ok || !d.ok) { setMsg(d.error ?? 'Could not create link token'); setBusy(false); return }
      localStorage.setItem(LS_KEY, d.linkToken)   // needed to resume after an OAuth redirect
      setMsg(`Opening Plaid (${d.env})…`)
      await open(d.linkToken)
      setBusy(false)
    } catch { setMsg('Network error'); setBusy(false) }
  }, [open])

  return (
    <div>
      <button onClick={connect} disabled={busy}
        className="bg-emerald-600 text-white text-sm font-semibold px-4 py-2 rounded-xl active:opacity-80 disabled:opacity-50">
        {busy ? 'Working…' : '+ Connect a bank (Plaid, read-only)'}
      </button>
      {msg && <p className="text-gray-400 text-xs mt-2">{msg}</p>}
      <p className="text-gray-600 text-xs mt-1">Bank login is entered only on Plaid&apos;s hosted page. Read-only; no money movement.</p>
    </div>
  )
}
