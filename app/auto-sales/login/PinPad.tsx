'use client'
/** Mobile shop-PIN entry (~390px). Enter the 4-digit PIN once per shift → establishes the employee
 *  session cookie → redirect back to where they were headed. The PIN is only POSTed to the session
 *  API; it is never stored client-side. */
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'

export default function PinPad() {
  const params = useSearchParams()
  // Only allow returning to a known internal employee tool path (prevents open redirects). If the
  // person was sent here trying to reach a tool, `next` returns them there; otherwise → the Work Board.
  const EMP_PATHS = ['/auto-sales', '/work-board', '/check-in', '/quick-entry', '/dealer-check-in']
  const rawNext = params.get('next') || '/work-board'
  const next = EMP_PATHS.some((p) => rawNext === p || rawNext.startsWith(p + '/')) ? rawNext : '/work-board'
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [signedInAs, setSignedInAs] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function submit(finalPin: string) {
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/auto-sales/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: finalPin }) })
      const j = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; actor?: { name?: string } | null }
      if (res.ok && j.ok) {
        // Success: the signed httpOnly ps_emp cookie is now set. A SOFT router.replace() here would serve
        // the router's stale RSC cache for `next` (prefetched while unauthenticated → a middleware redirect
        // back to login), so it never left this screen and "Checking…" stuck. A hard top-level navigation
        // makes the Edge middleware re-evaluate `next` with the fresh cookie — the reliable, cache-proof fix.
        setSignedInAs(j.actor?.name ?? 'you')   // brief confirmation while the destination loads
        window.location.assign(next)
        return                                   // stay busy; the page is unloading
      }
      setErr(j.error || 'Incorrect PIN'); setPin(''); setBusy(false)
    } catch { setErr('No connection — try again.'); setPin(''); setBusy(false) }
  }
  function press(d: string) {
    if (busy) return
    const nx = (pin + d).slice(0, 4); setPin(nx)
    if (nx.length === 4) submit(nx)
  }
  const back = () => setPin((p) => p.slice(0, -1))

  return (
    <div className="w-full max-w-xs mx-auto">
      <div className="flex justify-center gap-3 my-6">
        {[0, 1, 2, 3].map((i) => <div key={i} className={`w-4 h-4 rounded-full ${i < pin.length ? 'bg-white' : 'bg-gray-700'}`} />)}
      </div>
      {err && <p className="text-red-400 text-sm text-center mb-3">{err}</p>}
      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)} disabled={busy} className="h-16 rounded-2xl bg-gray-900 border border-gray-800 active:bg-gray-800 text-white text-2xl font-semibold disabled:opacity-50">{d}</button>
        ))}
        <div />
        <button onClick={() => press('0')} disabled={busy} className="h-16 rounded-2xl bg-gray-900 border border-gray-800 active:bg-gray-800 text-white text-2xl font-semibold disabled:opacity-50">0</button>
        <button onClick={back} disabled={busy} className="h-16 rounded-2xl text-gray-400 text-lg">⌫</button>
      </div>
      {signedInAs
        ? <p className="text-emerald-400 text-sm text-center mt-4">✓ Signed in as {signedInAs}…</p>
        : busy && <p className="text-gray-500 text-sm text-center mt-4">Checking…</p>}
    </div>
  )
}
