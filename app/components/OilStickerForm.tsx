'use client'

/**
 * THE oil-change sticker form — the single shared implementation of the preview, the fields, and
 * the honest print-status wording, used by BOTH entry points:
 *   - the Job detail sheet (app/orders/[id]/OilStickerSheet.tsx)
 *   - the homepage quick print (app/components/OilStickerQuickPrint.tsx)
 *
 * Nothing here is duplicated between them: the arithmetic comes from apps/stickers/calc.ts and the
 * PREVIEW is built from the SAME positioned payload (apps/stickers/render.ts) the printed PDF uses,
 * so what you see is what the QL-800 cuts — a 62 mm-wide label whose length is computed from the
 * content. No layout numbers, no logo, and no date/mileage maths live in this file.
 *
 * This module is presentation + local form state only: it performs no fetches and knows nothing
 * about orders, request tokens, or idempotency. Each caller owns its own server conversation.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { buildStickerPayload, type StickerPrintPayload } from '@/apps/stickers/render'
import { computeNextService, formatMiles, formatStickerDate } from '@/apps/stickers/calc'

const SCALE = 4.4 // preview px per mm (62 mm → ~273 px wide card)

/** Status of one print job, exactly as the sticker APIs report it. */
export type StickerJobView = { jobId: string; status: string; error: string | null; uncertain: boolean; createdAt: string }
export type LabelBridgeStatus = { online: boolean; labelPrinterConfigured: boolean }

export const MILE_PRESETS = [3000, 5000, 7500, 10000]
export const MONTH_PRESETS = [3, 6, 12]

/** A job that is still on its way to the printer — nothing new may be sent while one exists. */
export const isWaitingJob = (job: StickerJobView | null | undefined) =>
  !!job && ['queued', 'claimed'].includes(job.status)

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
export function StickerPreview({ payload }: { payload: StickerPrintPayload }) {
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

/** Preview card + the exact physical size it will print at. */
export function StickerPreviewCard({ payload }: { payload: StickerPrintPayload }) {
  return (
    <div className="mb-2 flex flex-col items-center">
      <StickerPreview payload={payload} />
      <p className="text-gray-600 text-xs mt-2">
        Prints {payload.pageWidthMm} × {payload.pageHeightMm} mm ({(payload.pageWidthMm / 25.4).toFixed(2)}&quot; × {(payload.pageHeightMm / 25.4).toFixed(2)}&quot;) on the QL-800
      </p>
    </div>
  )
}

export const fmtNum = (n: number | '' | null) => (n === '' || n == null ? '' : n.toLocaleString('en-US'))
export const parseNum = (s: string): number | '' => {
  const digits = s.replace(/[^0-9]/g, '')
  return digits ? Math.min(parseInt(digits, 10), 9_999_999) : ''
}

export interface StickerFormState {
  mileage: number | ''
  intervalMiles: number | ''
  intervalMonths: number | ''
  /** '' = use the computed value. */
  overrideMiles: number | ''
  overrideDate: string
  setMileage: (v: number | '') => void
  setIntervalMiles: (v: number | '') => void
  setIntervalMonths: (v: number | '') => void
  setOverrideMiles: (v: number | '') => void
  setOverrideDate: (v: string) => void
  /** Apply the interval prefill once the server answers (last sticker, else the shop defaults). */
  applyIntervals: (miles: number | null, months: number | null) => void
  resetOverrides: () => void
  hasOverride: boolean
  nextMileage: number | null
  nextDate: string | null
  nextDateText: string | null
  /** The positioned payload for the preview — null until the values make a printable sticker. */
  payload: StickerPrintPayload | null
  canPrint: boolean
  /** The values half of a print request body (the caller adds its own identifiers). */
  values: () => { mileage: number | ''; intervalMiles: number | null; intervalMonths: number | null; nextMileage?: number; nextDate?: string }
}

/**
 * Local form state + the computed next-service values. The interval drives the computation and
 * either computed value can be overridden by hand before printing; changing an input clears the
 * override it would otherwise silently contradict (the owner's rule: nothing assumes one interval
 * fits every vehicle, and the printed values are always the ones shown).
 */
export function useStickerForm(today?: string): StickerFormState {
  const [mileage, setMileageRaw] = useState<number | ''>('')
  const [intervalMiles, setIntervalMilesRaw] = useState<number | ''>('')
  const [intervalMonths, setIntervalMonthsRaw] = useState<number | ''>('')
  const [overrideMiles, setOverrideMiles] = useState<number | ''>('')
  const [overrideDate, setOverrideDate] = useState<string>('')

  const setMileage = useCallback((v: number | '') => { setMileageRaw(v); setOverrideMiles('') }, [])
  const setIntervalMiles = useCallback((v: number | '') => { setIntervalMilesRaw(v); setOverrideMiles('') }, [])
  const setIntervalMonths = useCallback((v: number | '') => { setIntervalMonthsRaw(v); setOverrideDate('') }, [])
  const applyIntervals = useCallback((miles: number | null, months: number | null) => {
    setIntervalMilesRaw(miles ?? ''); setIntervalMonthsRaw(months ?? '')
  }, [])
  const resetOverrides = useCallback(() => { setOverrideDate(''); setOverrideMiles('') }, [])

  const computed = useMemo(() => computeNextService({
    mileage: mileage === '' ? null : mileage,
    intervalMiles: intervalMiles === '' ? null : intervalMiles,
    intervalMonths: intervalMonths === '' ? null : intervalMonths,
    today,
  }), [mileage, intervalMiles, intervalMonths, today])

  const nextMileage = overrideMiles !== '' ? overrideMiles : computed.nextMileage
  const nextDate = overrideDate || computed.nextDate
  const nextDateText = formatStickerDate(nextDate)

  const payload = useMemo(() => {
    if (nextMileage == null || !nextDateText) return null
    // 'preview' ids: the layout does not depend on them, and a preview is not a record of anything.
    return buildStickerPayload({ stickerId: 'preview', orderId: 'preview', values: { nextDateText, nextMileageText: formatMiles(nextMileage) } })
  }, [nextMileage, nextDateText])

  const canPrint = mileage !== '' && nextMileage != null && nextMileage > (mileage as number) && !!nextDateText

  const values = useCallback(() => ({
    mileage,
    intervalMiles: intervalMiles === '' ? null : intervalMiles,
    intervalMonths: intervalMonths === '' ? null : intervalMonths,
    nextMileage: overrideMiles === '' ? undefined : overrideMiles,
    nextDate: overrideDate || undefined,
  }), [mileage, intervalMiles, intervalMonths, overrideMiles, overrideDate])

  return {
    mileage, intervalMiles, intervalMonths, overrideMiles, overrideDate,
    setMileage, setIntervalMiles, setIntervalMonths, setOverrideMiles, setOverrideDate,
    applyIntervals, resetOverrides, hasOverride: !!overrideDate || overrideMiles !== '',
    nextMileage, nextDate, nextDateText, payload, canPrint, values,
  }
}

const chipClass = (active: boolean) =>
  `px-3 py-2 rounded-xl text-sm font-semibold border transition-colors ${active ? 'bg-amber-500 text-black border-amber-500' : 'bg-gray-900 text-gray-300 border-gray-700 active:bg-gray-800'}`

const LABEL = 'block text-gray-400 text-xs font-semibold uppercase tracking-wider'

/**
 * Current mileage + interval + the editable next-service values. Every control is labelled and
 * reachable by keyboard; the presets are real buttons, not styled divs.
 */
export function StickerFields({ form, note, disabled = false, idPrefix = 'sticker', autoFocus = false }: {
  form: StickerFormState
  /** Optional context line under the mileage field (e.g. the vehicle's last sticker). */
  note?: ReactNode
  /** True while a sticker is already on its way — the values that were sent must not drift. */
  disabled?: boolean
  idPrefix?: string
  /** Focus the first field on mount (the quick-print dialog opens straight into it). */
  autoFocus?: boolean
}) {
  const id = (s: string) => `${idPrefix}-${s}`
  return (
    <>
      <label className={`${LABEL} mb-2`} htmlFor={id('mileage')}>Current mileage</label>
      <input id={id('mileage')} inputMode="numeric" autoComplete="off" placeholder="e.g. 187,781" disabled={disabled} autoFocus={autoFocus}
        value={fmtNum(form.mileage)} onChange={(e) => form.setMileage(parseNum(e.target.value))}
        className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3.5 text-white text-lg font-semibold mb-1 focus:outline-none focus:border-amber-500 disabled:opacity-50" />
      {note}

      <label className={`${LABEL} mt-4 mb-2`} htmlFor={id('interval-miles')}>Interval — miles</label>
      <div className="flex flex-wrap gap-2 mb-2">
        {MILE_PRESETS.map((m) => (
          <button key={m} type="button" disabled={disabled} aria-pressed={form.intervalMiles === m} className={chipClass(form.intervalMiles === m)}
            onClick={() => form.setIntervalMiles(m)}>{m.toLocaleString()}</button>
        ))}
        <input id={id('interval-miles')} inputMode="numeric" placeholder="Custom" aria-label="Custom mileage interval" disabled={disabled}
          value={MILE_PRESETS.includes(form.intervalMiles as number) ? '' : fmtNum(form.intervalMiles)}
          onChange={(e) => form.setIntervalMiles(parseNum(e.target.value))}
          className="w-24 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500 disabled:opacity-50" />
      </div>

      <label className={`${LABEL} mt-3 mb-2`} htmlFor={id('interval-months')}>Interval — months</label>
      <div className="flex flex-wrap gap-2 mb-4">
        {MONTH_PRESETS.map((m) => (
          <button key={m} type="button" disabled={disabled} aria-pressed={form.intervalMonths === m} className={chipClass(form.intervalMonths === m)}
            onClick={() => form.setIntervalMonths(m)}>{m} mo</button>
        ))}
        <input id={id('interval-months')} inputMode="numeric" placeholder="Custom" aria-label="Custom month interval" disabled={disabled}
          value={MONTH_PRESETS.includes(form.intervalMonths as number) ? '' : fmtNum(form.intervalMonths)}
          onChange={(e) => form.setIntervalMonths(parseNum(e.target.value))}
          className="w-20 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500 disabled:opacity-50" />
      </div>

      <span className={`${LABEL} mb-2`}>Next service due (editable)</span>
      {/* Stacked on a narrow phone (a 320 px-wide screen clipped the mileage), side by side from
          sm up. `min-w-0` so neither field can push the other out of the row. */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row">
        <div className="min-w-0 flex-1">
          <input id={id('next-date')} type="date" aria-label="Next service date" disabled={disabled} value={form.nextDate ?? ''}
            onChange={(e) => form.setOverrideDate(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-3 py-3 text-white text-sm focus:outline-none focus:border-amber-500 disabled:opacity-50" />
        </div>
        <div className="min-w-0 flex-1">
          <input id={id('next-mileage')} inputMode="numeric" placeholder="Next mileage" aria-label="Next service mileage" disabled={disabled}
            value={fmtNum(form.nextMileage ?? '')} onChange={(e) => form.setOverrideMiles(parseNum(e.target.value))}
            className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-3 py-3 text-white text-sm font-semibold focus:outline-none focus:border-amber-500 disabled:opacity-50" />
        </div>
      </div>
      {form.hasOverride && (
        <button type="button" disabled={disabled} className="text-sky-400 text-xs mb-4 underline" onClick={form.resetOverrides}>
          Reset to computed values
        </button>
      )}
    </>
  )
}

/** The label-printer link, worded so nobody has to guess what "offline" costs them. */
export function BridgeStatusLine({ bridge }: { bridge: LabelBridgeStatus | null | undefined }) {
  const ready = !!bridge?.online && !!bridge.labelPrinterConfigured
  return (
    <div className="flex items-center gap-2 mb-5">
      <span className={`w-2 h-2 rounded-full ${ready ? 'bg-green-500' : 'bg-red-500'}`} aria-hidden />
      <span className="text-xs text-gray-400">
        {bridge?.online
          ? bridge.labelPrinterConfigured ? 'Label printer link online' : 'Shop computer online — label printer not set up yet'
          : 'Shop computer offline — a sticker sent now expires after 10 minutes if it isn’t picked up'}
      </span>
    </div>
  )
}

/**
 * What a print job's status actually means, in shop language. 'submitted' is honestly "handed to
 * the printer", never "proof a sticker came out"; 'expired' says plainly that nothing will print.
 */
export function stickerStatusLine(job: StickerJobView | null): { tone: string; text: string } | null {
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
}
