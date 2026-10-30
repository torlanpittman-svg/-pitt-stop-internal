'use client'

/**
 * Oil-change reminder sticker — bottom sheet on the Job detail screen. Any signed-in
 * employee can print one (non-financial; never touches QuickBooks or job completion).
 *
 * The PREVIEW is built from the SAME positioned payload (apps/stickers/render.ts) the
 * printed PDF uses, so what you see is what the QL-800 cuts: a 62 mm-wide label whose
 * length is computed from the content.
 *
 * Print states are honest, like checks: "queued" (waiting for the shop computer),
 * "claimed" (printing), "submitted" (handed to the label printer — the sticker should be
 * out), "failed"/"expired" with the reason. Double-taps can't produce a second sticker
 * (server-enforced); reprints are a separate explicit button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildStickerPayload, type StickerPrintPayload } from '@/apps/stickers/render'
import { computeNextService, formatMiles, formatStickerDate } from '@/apps/stickers/calc'

const SCALE = 4.4 // preview px per mm (62 mm → ~273 px wide card)

type JobView = { jobId: string; status: string; error: string | null; uncertain: boolean; createdAt: string }
type Prefill = {
  vehicle: { year: string | null; make: string | null; model: string | null; color: string | null; licensePlate: string | null } | null
  lastSticker: { mileage: number; intervalMiles: number | null; intervalMonths: number | null; createdAt: string } | null
  defaults: { intervalMiles: number; intervalMonths: number }
  today: string
  bridge: { online: boolean; labelPrinterConfigured: boolean }
  activeJob: JobView | null
  lastJob: JobView | null
}

const MILE_PRESETS = [3000, 5000, 7500, 10000]
const MONTH_PRESETS = [3, 6, 12]

function CalendarIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden>
      <rect x="2.5" y="4.5" width="19" height="17" rx="1.5" />
      <line x1="7.5" y1="1.5" x2="7.5" y2="7" /><line x1="16.5" y1="1.5" x2="16.5" y2="7" />
      <line x1="2.5" y1="10" x2="21.5" y2="10" />
      {[0, 1, 2].map((c) => [0, 1].map((r) => (
        <rect key={`${c}-${r}`} x={6 + c * 5.4} y={12.6 + r * 4.4} width="2.4" height="2.4" fill="currentColor" stroke="none" />
      )))}
    </svg>
  )
}
function GaugeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
      <path d="M 2.8 16.5 A 9.2 9.2 0 0 1 21.2 16.5" />
      <line x1="2.8" y1="16.5" x2="21.2" y2="16.5" />
      <line x1="12" y1="16.5" x2="7.6" y2="12.1" />
      <circle cx="12" cy="16.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** The label, rendered 1:1 from the print payload (positions in mm × SCALE). */
function StickerPreview({ payload }: { payload: StickerPrintPayload }) {
  const w = payload.pageWidthMm * SCALE
  const h = payload.pageHeightMm * SCALE
  const PT_TO_PX = (SCALE * 25.4) / 72
  return (
    <div className="relative bg-white rounded-lg shadow-lg overflow-hidden text-black shrink-0" style={{ width: w, height: h }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/stickers/pitt-stop-logo-print.png" alt="Pitt Stop — Detail & Auto Sales"
        style={{ position: 'absolute', left: payload.logo.xMm * SCALE, top: payload.logo.yMm * SCALE, width: payload.logo.wMm * SCALE, height: payload.logo.hMm * SCALE }} />
      {payload.texts.map((t, i) => (
        <span key={i} style={{
          position: 'absolute', left: t.xMm * SCALE, top: t.yMm * SCALE,
          transform: 'translateY(-100%)', lineHeight: 1,
          fontSize: t.sizePt * PT_TO_PX, fontWeight: t.bold ? 700 : 400,
          fontFamily: 'Helvetica, Arial, sans-serif', whiteSpace: 'nowrap',
        }}>{t.value}</span>
      ))}
      {payload.icons.map((ic, i) => (
        <span key={i} style={{ position: 'absolute', left: ic.xMm * SCALE, top: ic.yMm * SCALE, color: '#000' }}>
          {ic.kind === 'calendar' ? <CalendarIcon size={ic.sizeMm * SCALE} /> : <GaugeIcon size={ic.sizeMm * SCALE} />}
        </span>
      ))}
    </div>
  )
}

const fmtNum = (n: number | '' | null) => (n === '' || n == null ? '' : n.toLocaleString('en-US'))
const parseNum = (s: string): number | '' => {
  const digits = s.replace(/[^0-9]/g, '')
  return digits ? Math.min(parseInt(digits, 10), 9_999_999) : ''
}

export default function OilStickerSheet({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [prefill, setPrefill] = useState<Prefill | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [mileage, setMileage] = useState<number | ''>('')
  const [intMiles, setIntMiles] = useState<number | ''>('')
  const [intMonths, setIntMonths] = useState<number | ''>('')
  const [overrideMiles, setOverrideMiles] = useState<number | ''>('')   // '' = use computed
  const [overrideDate, setOverrideDate] = useState<string>('')          // '' = use computed
  const [stickerId, setStickerId] = useState<string | null>(null)
  const [job, setJob] = useState<JobView | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load prefill
  useEffect(() => {
    let dead = false
    fetch(`/api/workflow/orders/${orderId}/oil-sticker`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `HTTP ${r.status}`); return r.json() })
      .then((d: Prefill) => {
        if (dead) return
        setPrefill(d)
        setIntMiles(d.lastSticker?.intervalMiles ?? d.defaults.intervalMiles)
        setIntMonths(d.lastSticker?.intervalMonths ?? d.defaults.intervalMonths)
        if (d.activeJob ?? d.lastJob) setJob(d.activeJob ?? d.lastJob)
      })
      .catch((e) => { if (!dead) setLoadError(String(e.message ?? e)) })
    return () => { dead = true }
  }, [orderId])

  const computed = useMemo(() => computeNextService({
    mileage: mileage === '' ? null : mileage,
    intervalMiles: intMiles === '' ? null : intMiles,
    intervalMonths: intMonths === '' ? null : intMonths,
    today: prefill?.today,
  }), [mileage, intMiles, intMonths, prefill?.today])

  const nextMileage = overrideMiles !== '' ? overrideMiles : computed.nextMileage
  const nextDate = overrideDate || computed.nextDate
  const nextDateText = formatStickerDate(nextDate)

  const payload = useMemo(() => {
    if (nextMileage == null || !nextDateText) return null
    return buildStickerPayload({ stickerId: 'preview', orderId, values: { nextDateText, nextMileageText: formatMiles(nextMileage) } })
  }, [nextMileage, nextDateText, orderId])

  const canPrint = mileage !== '' && nextMileage != null && nextMileage > (mileage as number) && !!nextDateText

  // Poll the active job
  const poll = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/workflow/orders/${orderId}/oil-sticker/status?jobId=${jobId}`)
        if (!r.ok) return
        const j: JobView = await r.json()
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
    submit({
      mileage, intervalMiles: intMiles === '' ? null : intMiles, intervalMonths: intMonths === '' ? null : intMonths,
      nextMileage: overrideMiles === '' ? undefined : overrideMiles,
      nextDate: overrideDate || undefined,
    })
  }
  const reprint = () => { if (stickerId && !busy) submit({ reprintStickerId: stickerId }) }

  const waiting = job != null && ['queued', 'claimed'].includes(job.status)
  const bridge = prefill?.bridge

  const vehicleLine = prefill?.vehicle
    ? [prefill.vehicle.year, prefill.vehicle.make, prefill.vehicle.model].filter(Boolean).join(' ') || 'Vehicle'
    : ''

  const chip = (active: boolean) =>
    `px-3 py-2 rounded-xl text-sm font-semibold border transition-colors ${active ? 'bg-amber-500 text-black border-amber-500' : 'bg-gray-900 text-gray-300 border-gray-700 active:bg-gray-800'}`

  const statusLine = (() => {
    if (!job) return null
    if (job.status === 'queued') return { tone: 'text-sky-300', text: 'Sent — waiting for the shop computer to pick it up (expires in 10 minutes if it stays offline).' }
    if (job.status === 'claimed') return job.uncertain
      ? { tone: 'text-amber-300', text: 'The shop computer took the job but hasn’t reported back — check the printer.' }
      : { tone: 'text-sky-300', text: 'Printing at the shop…' }
    if (job.status === 'submitted') return { tone: 'text-green-400', text: '✓ Sent to the label printer — the sticker should be out.' }
    if (job.status === 'expired') return { tone: 'text-amber-300', text: 'The shop computer didn’t pick this up in time, so it expired without printing. Nothing will print — send it again when the printer link is online.' }
    if (job.status === 'failed') return { tone: 'text-red-400', text: `Print failed — ${job.error ?? 'unknown reason'}` }
    if (job.status === 'canceled') return { tone: 'text-gray-400', text: 'Canceled before printing.' }
    return { tone: 'text-gray-400', text: job.status }
  })()

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
            {/* Bridge status */}
            <div className="flex items-center gap-2 mb-5">
              <span className={`w-2 h-2 rounded-full ${bridge?.online && bridge.labelPrinterConfigured ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs text-gray-400">
                {bridge?.online
                  ? bridge.labelPrinterConfigured ? 'Label printer link online' : 'Shop computer online — label printer not set up yet'
                  : 'Shop computer offline — a sticker sent now expires after 10 minutes if it isn’t picked up'}
              </span>
            </div>

            {/* Current mileage */}
            <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">Current mileage</label>
            <input inputMode="numeric" autoComplete="off" placeholder="e.g. 187,781"
              value={fmtNum(mileage)} onChange={(e) => { setMileage(parseNum(e.target.value)); setOverrideMiles('') }}
              className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3.5 text-white text-lg font-semibold mb-1 focus:outline-none focus:border-amber-500" />
            {prefill.lastSticker && (
              <p className="text-gray-600 text-xs mb-4">Last sticker: {fmtNum(prefill.lastSticker.mileage)} mi on {new Date(prefill.lastSticker.createdAt).toLocaleDateString()}</p>
            )}

            {/* Interval */}
            <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mt-4 mb-2">Interval — miles</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {MILE_PRESETS.map((m) => (
                <button key={m} className={chip(intMiles === m)} onClick={() => { setIntMiles(m); setOverrideMiles('') }}>{m.toLocaleString()}</button>
              ))}
              <input inputMode="numeric" placeholder="Custom" value={MILE_PRESETS.includes(intMiles as number) ? '' : fmtNum(intMiles)}
                onChange={(e) => { setIntMiles(parseNum(e.target.value)); setOverrideMiles('') }}
                className="w-24 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500" />
            </div>
            <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mt-3 mb-2">Interval — months</label>
            <div className="flex flex-wrap gap-2 mb-4">
              {MONTH_PRESETS.map((m) => (
                <button key={m} className={chip(intMonths === m)} onClick={() => { setIntMonths(m); setOverrideDate('') }}>{m} mo</button>
              ))}
              <input inputMode="numeric" placeholder="Custom" value={MONTH_PRESETS.includes(intMonths as number) ? '' : fmtNum(intMonths)}
                onChange={(e) => { setIntMonths(parseNum(e.target.value)); setOverrideDate('') }}
                className="w-20 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500" />
            </div>

            {/* Next due — editable overrides */}
            <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">Next service due (editable)</label>
            <div className="flex gap-3 mb-5">
              <div className="flex-1">
                <input type="date" value={nextDate ?? ''} onChange={(e) => setOverrideDate(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-3 py-3 text-white text-sm focus:outline-none focus:border-amber-500" />
              </div>
              <div className="flex-1">
                <input inputMode="numeric" placeholder="Next mileage" value={fmtNum(nextMileage ?? '')}
                  onChange={(e) => setOverrideMiles(parseNum(e.target.value))}
                  className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-3 py-3 text-white text-sm font-semibold focus:outline-none focus:border-amber-500" />
              </div>
            </div>
            {(overrideDate || overrideMiles !== '') && (
              <button className="text-sky-400 text-xs mb-4 underline" onClick={() => { setOverrideDate(''); setOverrideMiles('') }}>
                Reset to computed values
              </button>
            )}

            {/* Preview — exact print layout */}
            {payload && (
              <div className="mb-2 flex flex-col items-center">
                <StickerPreview payload={payload} />
                <p className="text-gray-600 text-xs mt-2">
                  Prints {payload.pageWidthMm} × {payload.pageHeightMm} mm ({(payload.pageWidthMm / 25.4).toFixed(2)}&quot; × {(payload.pageHeightMm / 25.4).toFixed(2)}&quot;) on the QL-800
                </p>
              </div>
            )}

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
