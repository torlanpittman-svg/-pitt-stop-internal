'use client'

/**
 * Oil-change reminder sticker — bottom sheet on the Job detail screen. Any signed-in
 * employee can print one (non-financial; never touches QuickBooks or job completion).
 *
 * The form, the PREVIEW, and the status wording come from the SHARED
 * app/components/OilStickerForm.tsx, which the homepage quick-print entry also uses — one design
 * and one calculation for both. The preview is built from the SAME positioned payload
 * (apps/stickers/render.ts) the printed PDF uses, so what you see is what the QL-800 cuts.
 *
 * Print states are honest, like checks: "queued" (waiting for the shop computer),
 * "claimed" (printing), "submitted" (handed to the label printer — the sticker should be
 * out), "failed"/"expired" with the reason. Double-taps can't produce a second sticker
 * (server-enforced); reprints are a separate explicit button.
 *
 * THIS screen's server conversation is unchanged: it is keyed on the ORDER
 * (/api/workflow/orders/[id]/oil-sticker), records a row in oil_change_stickers, and reprints an
 * existing sticker by id. The quick-print entry is a separate path and does not affect it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BridgeStatusLine, StickerFields, StickerPreviewCard, fmtNum, isWaitingJob, stickerStatusLine,
  useStickerForm, type LabelBridgeStatus, type StickerJobView,
} from '@/app/components/OilStickerForm'

type Prefill = {
  vehicle: { year: string | null; make: string | null; model: string | null; color: string | null; licensePlate: string | null } | null
  lastSticker: { mileage: number; intervalMiles: number | null; intervalMonths: number | null; createdAt: string } | null
  defaults: { intervalMiles: number; intervalMonths: number }
  today: string
  bridge: LabelBridgeStatus
  activeJob: StickerJobView | null
  lastJob: StickerJobView | null
}

export default function OilStickerSheet({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [prefill, setPrefill] = useState<Prefill | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const form = useStickerForm(prefill?.today)
  const [stickerId, setStickerId] = useState<string | null>(null)
  const [job, setJob] = useState<StickerJobView | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const applyIntervals = form.applyIntervals

  // Load prefill
  useEffect(() => {
    let dead = false
    fetch(`/api/workflow/orders/${orderId}/oil-sticker`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `HTTP ${r.status}`); return r.json() })
      .then((d: Prefill) => {
        if (dead) return
        setPrefill(d)
        applyIntervals(d.lastSticker?.intervalMiles ?? d.defaults.intervalMiles, d.lastSticker?.intervalMonths ?? d.defaults.intervalMonths)
        if (d.activeJob ?? d.lastJob) setJob(d.activeJob ?? d.lastJob)
      })
      .catch((e) => { if (!dead) setLoadError(String(e.message ?? e)) })
    return () => { dead = true }
  }, [orderId, applyIntervals])

  const payload = form.payload
  const canPrint = form.canPrint

  // Poll the active job
  const poll = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/workflow/orders/${orderId}/oil-sticker/status?jobId=${jobId}`)
        if (!r.ok) return
        const j: StickerJobView = await r.json()
        setJob(j)
        if (!['queued', 'claimed'].includes(j.status)) { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null }
      } catch { /* transient */ }
    }, 2500)
  }, [orderId])
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])
  useEffect(() => { if (job && ['queued', 'claimed'].includes(job.status) && !pollRef.current) poll(job.jobId) }, [job, poll])

  const submit = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`/api/workflow/orders/${orderId}/oil-sticker`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await r.json().catch(() => null)
      if (!r.ok) { setMsg(d?.message ?? `Could not queue the sticker (HTTP ${r.status}).`); return }
      setStickerId(d.stickerId); setJob(d.job)
      if (d.alreadyQueued) setMsg('A sticker for this job is already on its way to the printer.')
      poll(d.job.jobId)
    } catch (e) { setMsg(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }, [orderId, poll])

  const printSticker = () => {
    if (!canPrint || busy) return
    submit(form.values())
  }
  const reprint = () => { if (stickerId && !busy) submit({ reprintStickerId: stickerId }) }

  const waiting = isWaitingJob(job)

  const vehicleLine = prefill?.vehicle
    ? [prefill.vehicle.year, prefill.vehicle.make, prefill.vehicle.model].filter(Boolean).join(' ') || 'Vehicle'
    : ''

  const statusLine = useMemo(() => stickerStatusLine(job), [job])

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div className="bg-gray-950 border-t border-gray-800 rounded-t-3xl max-h-[92vh] overflow-y-auto px-6 pt-5 pb-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-white font-bold text-xl">Oil Change Sticker</h2>
          <button onClick={onClose} className="text-gray-400 text-2xl px-2 py-1" aria-label="Close">×</button>
        </div>
        {vehicleLine && <p className="text-gray-500 text-sm mb-4">{vehicleLine}{prefill?.vehicle?.licensePlate ? ` · ${prefill.vehicle.licensePlate}` : ''}</p>}

        {loadError && <p className="text-red-400 text-sm mb-4">{loadError}</p>}
        {!prefill && !loadError && <p className="text-gray-500 text-sm mb-4">Loading…</p>}

        {prefill && (
          <>
            <BridgeStatusLine bridge={prefill.bridge} />

            <StickerFields
              form={form}
              idPrefix="job-sticker"
              note={prefill.lastSticker ? (
                <p className="text-gray-600 text-xs mb-4">Last sticker: {fmtNum(prefill.lastSticker.mileage)} mi on {new Date(prefill.lastSticker.createdAt).toLocaleDateString()}</p>
              ) : null}
            />

            {/* Preview — exact print layout */}
            {payload && <StickerPreviewCard payload={payload} />}

            {/* Status + actions */}
            {statusLine && <p className={`${statusLine.tone} text-sm text-center my-3`}>{statusLine.text}</p>}
            {msg && <p className="text-amber-300 text-sm text-center my-2">{msg}</p>}

            {job?.status === 'submitted' && stickerId ? (
              <button disabled={busy} onClick={reprint}
                className="w-full text-amber-300 font-semibold text-base py-3.5 rounded-2xl border border-amber-800/60 bg-amber-950/30 active:opacity-80 disabled:opacity-40 mt-2">
                {busy ? 'Sending…' : 'Print another copy'}
              </button>
            ) : (
              <button disabled={!canPrint || busy || waiting} onClick={printSticker}
                className="w-full text-black font-bold text-lg py-4 rounded-2xl bg-amber-500 active:bg-amber-600 transition-colors disabled:opacity-40 mt-2">
                {busy ? 'Sending…' : waiting ? 'Sticker on its way…' : (job && ['failed', 'expired', 'canceled'].includes(job.status)) ? 'Send Again' : 'Print Oil Change Sticker'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
