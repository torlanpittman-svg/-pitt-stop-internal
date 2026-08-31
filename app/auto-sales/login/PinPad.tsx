'use client'
/** Mobile shop-PIN entry (~390px). Enter the 4-digit PIN once per shift → establishes the employee
 *  session cookie → redirect back to where they were headed. The PIN is only POSTed to the session
 *  API; it is never stored client-side. */
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export default function PinPad() {
  const router = useRouter()
  const params = useSearchParams()
  // Only allow returning to a known internal employee tool path (prevents open redirects).
  const EMP_PATHS = ['/auto-sales', '/work-board', '/check-in', '/quick-entry', '/dealer-check-in']
  const rawNext = params.get('next') || '/auto-sales'
  const next = EMP_PATHS.some((p) => rawNext === p || rawNext.startsWith(p + '/')) ? rawNext : '/auto-sales'
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(finalPin: string) {
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/auto-sales/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: finalPin }) })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j.ok) { router.replace(next); router.refresh() }
      else { setErr(j.error || 'Wrong PIN'); setPin(''); setBusy(false) }
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
      {busy && <p className="text-gray-500 text-sm text-center mt-4">Checking…</p>}
    </div>
  )
}
