'use client'
/**
 * Shop-printer controls for ONE recorded check — the single place a check is sent, watched, and settled.
 *
 * "Sent to the printer" is not proof that paper came out, so the flow is:
 *   send → waiting → printing → SENT (manager looks at the printer) → confirmed printed | not printed.
 * While a job is open the send button is not offered at all (the server also refuses a second job), so a
 * double tap or a second manager cannot produce a second copy. A reprint is a separate, deliberate action.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Job { id: string; kind: string; status: string; uncertain?: boolean; error: string | null }
interface Bridge { online: boolean; unknown?: boolean; bridges: { bridgeId: string; lastSeenAt: string }[] }
const ACTIVE = ['queued', 'claimed', 'submitted', 'stuck']

export default function CheckPrintPanel(props: { checkId: string; checkNumber: number; printStatus: string }) {
  const router = useRouter()
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [printStatus, setPrintStatus] = useState(props.printStatus)
  const [bridge, setBridge] = useState<Bridge | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reprintOk, setReprintOk] = useState(false)
  const [clearedOk, setClearedOk] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/checks/${props.checkId}/jobs`, { cache: 'no-store' })
      if (res.ok) setJobs(((await res.json()).jobs ?? []) as Job[])
    } catch { /* keep last known state; next poll retries */ }
  }, [props.checkId])
  const loadBridge = useCallback(async () => {
    try { const res = await fetch('/api/checks/bridge-status', { cache: 'no-store' }); if (res.ok) setBridge(await res.json()) } catch { /* ignore */ }
  }, [])

  const active = jobs?.find((j) => ACTIVE.includes(j.status)) ?? null
  const latest = jobs?.[0] ?? null

  // Initial fetch (deferred a tick so state is only ever set from an async callback).
  useEffect(() => { const t = setTimeout(() => { load(); loadBridge() }, 0); return () => clearTimeout(t) }, [load, loadBridge])
  // Poll while a job is open so the manager sees it move without refreshing.
  useEffect(() => {
    if (!active) return
    timer.current = setTimeout(() => { load(); if (active.status === 'queued') loadBridge() }, 2500)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [active, jobs, load, loadBridge])

  async function post(path: string, body: unknown): Promise<boolean> {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/checks/${props.checkId}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || 'That did not go through.'); await load(); return false }
      if (data.check?.printStatus) setPrintStatus(data.check.printStatus)
      await load(); router.refresh()
      return true
    } catch (e) { setError(String((e as Error).message)); return false } finally { setBusy(false) }
  }
  const send = (reprint: boolean) => post('queue-print', { reprint }).then((ok) => { if (ok) setReprintOk(false) })
  const settle = (outcome: 'printed' | 'not_printed' | 'cleared' | 'cancel') => active && post('confirm-print', { jobId: active.id, outcome })

  const btn = 'w-full rounded-xl py-3 font-semibold disabled:opacity-50'
  const n = props.checkNumber

  return (
    <div className="space-y-3" aria-live="polite">
      {bridge && !bridge.unknown && (
        <p className={`text-center text-xs ${bridge.online ? 'text-emerald-700' : 'text-red-700'}`}>
          Shop printer link: {bridge.online ? 'online' : bridge.bridges[0] ? `OFFLINE — last seen ${new Date(bridge.bridges[0].lastSeenAt).toLocaleString()}` : 'OFFLINE — never connected'}
        </p>
      )}

      {jobs === null && <p className="text-center text-sm text-neutral-500">Checking printer status…</p>}

      {active?.status === 'queued' && (
        <div className="space-y-2 rounded-xl border border-neutral-300 p-3">
          <p className="text-sm font-medium">Waiting for the shop printer to pick up check #{n}…</p>
          {bridge && !bridge.online && <p className="text-sm text-red-700">The shop printer link is offline. This will not print until it is back; it expires on its own after 10 minutes.</p>}
          <button disabled={busy} onClick={() => settle('cancel')} className={`${btn} border border-neutral-300 text-sm`}>Cancel — don’t print</button>
        </div>
      )}

      {active?.status === 'claimed' && !active.uncertain && (
        <p className="rounded-xl border border-neutral-300 p-3 text-center text-sm font-medium">Printing check #{n}…</p>
      )}

      {active && (active.status === 'submitted' || active.uncertain) && (
        <div className="space-y-2 rounded-xl border border-amber-400 bg-amber-50 p-3 text-amber-950">
          <p className="font-semibold">{active.status === 'submitted' ? `Check #${n} was sent to the printer.` : `The printer never reported back for check #${n}.`}</p>
          <p className="text-sm">Look at the printer. Did the check come out complete and readable?</p>
          {active.error && <p className="text-xs">{active.error}</p>}
          <button disabled={busy} onClick={() => settle('printed')} className={`${btn} bg-emerald-600 text-white`}>Yes — the check printed</button>
          <button disabled={busy} onClick={() => settle('not_printed')} className={`${btn} border border-amber-500 bg-white`}>No — the check didn’t come out</button>
        </div>
      )}

      {active?.status === 'stuck' && (
        <div className="space-y-2 rounded-xl border border-red-400 bg-red-50 p-3 text-red-950">
          <p className="font-semibold">Check #{n} has not printed — but it may still be waiting.</p>
          <p className="text-sm">If the printer was offline, out of paper or jammed, the original can print later by itself. Before sending it again, make sure it can’t:</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>On the shop laptop, open the Brother’s print queue and cancel every document.</li>
            <li>Turn the Brother off, wait ten seconds, and turn it back on.</li>
          </ol>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={clearedOk} onChange={(e) => setClearedOk(e.target.checked)} className="mt-1" />
            <span>I did both. Nothing is waiting to print.</span>
          </label>
          <button disabled={busy || !clearedOk} onClick={() => settle('cleared')?.then((ok) => { if (ok) setClearedOk(false) })} className={`${btn} bg-neutral-900 text-white`}>Original is cleared — let me send it again</button>
          <button disabled={busy} onClick={() => settle('printed')} className={`${btn} border border-red-300 bg-white text-sm`}>It printed after all</button>
        </div>
      )}

      {jobs !== null && !active && (
        <>
          {latest && ['failed', 'expired', 'canceled'].includes(latest.status) && printStatus !== 'printed' && (
            <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">Last attempt did not print{latest.error ? `: ${latest.error}` : '.'}</p>
          )}
          {printStatus === 'printed' ? (
            <div className="space-y-2">
              <p className="text-center text-sm font-medium text-emerald-700">Check #{n} printed ✓ (confirmed)</p>
              <label className="flex items-start gap-2 text-sm text-neutral-700">
                <input type="checkbox" checked={reprintOk} onChange={(e) => setReprintOk(e.target.checked)} className="mt-1" />
                <span>The original check #{n} was destroyed or never left the shop. Print a replacement with the same number.</span>
              </label>
              <button disabled={busy || !reprintOk} onClick={() => send(true)} className={`${btn} border border-neutral-400 text-sm`}>Reprint check #{n}</button>
            </div>
          ) : (
            <button disabled={busy} onClick={() => send(false)} className={`${btn} bg-neutral-900 text-lg text-white`}>{busy ? 'Sending…' : `Send Check #${n} to Shop Printer`}</button>
          )}
        </>
      )}

      {error && <p className="rounded-lg bg-red-50 p-2 text-center text-sm text-red-700">{error}</p>}
    </div>
  )
}
