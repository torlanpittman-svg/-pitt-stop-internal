'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { YEARS, MAKES, COLORS, getModelsForMake } from '@/apps/vehicle-entry/vehicle-data'
import type { VehicleEntryRow } from '@/apps/vehicle-entry/db'
import type { SyncOutcome } from '@/apps/vehicle-entry/types'

const HIGH = 0.85
const MID  = 0.60
const STOCK_AUTOFOCUS_THRESHOLD = 0.90

function borderClass(value: string | null, c: number | undefined): string {
  if (!value)            return 'border-l-red-600'
  if ((c ?? 0) >= HIGH)  return 'border-l-green-600'
  if ((c ?? 0) >= MID)   return 'border-l-yellow-500'
  return 'border-l-red-600'
}

function confidenceNote(value: string | null, c: number | undefined): string | null {
  if (!value) return 'Could not read — must correct'
  const pct = Math.round((c ?? 0) * 100)
  if ((c ?? 0) >= HIGH) return null
  if ((c ?? 0) >= MID)  return `${pct}% confident — please verify`
  return `Low confidence (${pct}%) — please correct`
}

function noteColor(c: number | undefined): string {
  if ((c ?? 0) >= MID) return 'text-yellow-400'
  return 'text-red-400'
}

function Field({
  label,
  value,
  confidence,
}: {
  label: string
  value: string | null
  confidence?: number
}) {
  const note = confidenceNote(value, confidence)
  return (
    <div className={`bg-gray-800 rounded-xl p-4 border-l-4 ${borderClass(value, confidence)}`}>
      <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-xl font-bold ${value ? 'text-white' : 'text-red-400'}`}>
        {value ?? '—'}
      </div>
      {note && (
        <div className={`text-xs mt-1 ${noteColor(confidence)}`}>⚠ {note}</div>
      )}
    </div>
  )
}

function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <label className="text-gray-400 text-xs uppercase tracking-wide">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-3 text-base appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">{placeholder ?? `Select ${label}`}</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  )
}

function StockDebugPanel({
  entry,
}: {
  entry: VehicleEntryRow
}) {
  const debug = (entry.stockDebugData ?? {}) as Record<string, unknown>
  const source      = (debug.source ?? '—') as string
  const fullPred    = (debug.fullImagePrediction ?? null) as string | null
  const fullConf    = typeof debug.fullImageConfidence === 'number' ? debug.fullImageConfidence : 0
  const cropPred    = (debug.cropPrediction ?? null) as string | null
  const cropConf    = typeof debug.cropConfidence === 'number' ? debug.cropConfidence : 0
  const boxValid    = debug.boxValid === true
  const rawBox      = debug.rawDetectionBox as Record<string, number> | null ?? null
  const paddedBox   = debug.paddedBox       as Record<string, number> | null ?? null
  const hasCrop     = !!entry.stockNumberCropUrl
  const hasOverlay  = !!entry.stockDebugOverlayUrl

  const sourceColor =
    source === 'crop'       ? 'text-green-400' :
    source === 'full-image' ? 'text-blue-400'  : 'text-gray-400'

  const fmt = (v: number) => `${Math.round(v * 100)}%`
  const fmtBox = (b: Record<string, number> | null) =>
    b ? `L${Math.round(b.left * 100)} T${Math.round(b.top * 100)} R${Math.round(b.right * 100)} B${Math.round(b.bottom * 100)}` : '—'

  return (
    <details className="bg-gray-900 border border-yellow-700/50 rounded-xl overflow-hidden">
      <summary className="px-4 py-3 text-yellow-400 text-xs font-semibold cursor-pointer select-none uppercase tracking-wide">
        Debug: Stock Number Detection ▾
      </summary>
      <div className="px-4 pb-4 space-y-3">

        {/* Overlay image — original with boxes drawn */}
        {hasOverlay && (
          <div>
            <div className="text-gray-500 text-xs mb-1">
              Overlay — <span className="text-yellow-300">yellow dashed = raw box</span>,{' '}
              <span className="text-red-400">red solid = padded crop</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/vehicle-entry/entries/${entry.id}/stock-debug`}
              alt="Debug overlay"
              className="w-full rounded-lg"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          </div>
        )}

        {/* Padded crop */}
        {hasCrop && boxValid && (
          <div>
            <div className="text-gray-500 text-xs mb-1">Padded crop</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/vehicle-entry/entries/${entry.id}/stock-crop`}
              alt="Stock number crop"
              className="w-full rounded-lg object-contain max-h-24 bg-gray-800"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          </div>
        )}

        {/* Predictions */}
        <div className="space-y-1 text-xs font-mono">
          <div className="flex gap-2">
            <span className="text-gray-500 w-24">Full image</span>
            <span className="text-white">{fullPred ?? 'null'}</span>
            <span className="text-gray-500">({fmt(fullConf)})</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-500 w-24">Crop</span>
            <span className={boxValid ? 'text-white' : 'text-gray-600'}>{cropPred ?? 'null'}</span>
            <span className="text-gray-500">{boxValid ? `(${fmt(cropConf)})` : '(box invalid)'}</span>
          </div>
          <div className="flex gap-2 pt-1 border-t border-gray-700">
            <span className="text-gray-500 w-24">Using</span>
            <span className={`font-bold ${sourceColor}`}>{source}</span>
          </div>
        </div>

        {/* Box coordinates */}
        <div className="space-y-1 text-xs font-mono">
          <div className="flex gap-2">
            <span className="text-gray-500 w-24">Box valid</span>
            <span className={boxValid ? 'text-green-400' : 'text-red-400'}>{boxValid ? 'yes' : 'no'}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-500 w-24">Raw box</span>
            <span className="text-gray-300">{fmtBox(rawBox)}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-500 w-24">Padded box</span>
            <span className="text-gray-300">{fmtBox(paddedBox)}</span>
          </div>
        </div>

      </div>
    </details>
  )
}

type Mode = 'review' | 'edit' | 'saving' | 'done'

const isVINEntry = (entry: VehicleEntryRow) => entry.entryMethod === 'vin-fallback'
const isPhotoEntry = (entry: VehicleEntryRow) =>
  !entry.photoUrl.startsWith('manual://') &&
  !entry.photoUrl.startsWith('test://') &&
  !entry.photoUrl.startsWith('vin://')

export default function ConfirmForm({
  entry,
  startInEditMode = false,
}: {
  entry: VehicleEntryRow
  startInEditMode?: boolean
}) {
  const router = useRouter()
  const conf = (entry.ocrConfidence ?? {}) as Record<string, number>

  const stockLowConf =
    !entry.stockNumber || (conf.stockNumber ?? 0) < STOCK_AUTOFOCUS_THRESHOLD

  const [mode, setMode] = useState<Mode>(
    startInEditMode || stockLowConf ? 'edit' : 'review'
  )
  const [syncOutcome, setSyncOutcome] = useState<SyncOutcome | null>(null)
  const [fields, setFields] = useState({
    year:        entry.year        ?? '',
    make:        entry.make        ?? '',
    model:       entry.model       ?? '',
    color:       entry.color       ?? '',
    customColor: entry.customColor ?? '',
    stockNumber: entry.stockNumber ?? '',
  })

  const stockInputRef = useRef<HTMLInputElement>(null)

  // Auto-focus stock number when entering edit mode with low confidence
  useEffect(() => {
    if (mode === 'edit' && stockLowConf) {
      // Small delay so the DOM has rendered
      const t = setTimeout(() => stockInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [mode, stockLowConf])

  const hasLowConfidence =
    Object.values(conf).some((c) => c < MID) ||
    !entry.year || !entry.make || !entry.model || !entry.color || !entry.stockNumber

  const submit = useCallback(
    async (corrected: boolean, overrideFields?: typeof fields) => {
      setMode('saving')
      const data = overrideFields ?? fields

      // Per-field correction: compare final value against original AI prediction
      const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
      const yearWasCorrected  = norm(data.year)        !== norm(entry.aiYear)
      const makeWasCorrected  = norm(data.make)        !== norm(entry.aiMake)
      const modelWasCorrected = norm(data.model)       !== norm(entry.aiModel)
      const colorWasCorrected = norm(data.color)       !== norm(entry.aiColor)
      const stockWasCorrected = norm(data.stockNumber) !== norm(entry.stockNumberAiPrediction)
      // Any field changed → wasCorrected
      const anyChanged = yearWasCorrected || makeWasCorrected || modelWasCorrected ||
                         colorWasCorrected || stockWasCorrected

      await fetch(`/api/vehicle-entry/entries/${entry.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year:               data.year        || null,
          make:               data.make        || null,
          model:              data.model       || null,
          color:              data.color       || null,
          customColor:        data.customColor || null,
          stockNumber:        data.stockNumber || null,
          wasCorrected:       corrected || anyChanged,
          yearWasCorrected,
          makeWasCorrected,
          modelWasCorrected,
          colorWasCorrected,
          stockWasCorrected,
          status:             'ready_for_quickbooks',
        }),
      })
      // Trigger invoice sync
      try {
        const syncRes = await fetch(`/api/vehicle-entry/entries/${entry.id}/sync-invoice`, {
          method: 'POST',
        })
        if (syncRes.ok) {
          const outcome = await syncRes.json() as SyncOutcome
          setSyncOutcome(outcome)
        }
      } catch {
        // Sync failed — show generic done screen, admin can review
      }
      setMode('done')
    },
    [entry.id, fields]
  )

  const handleMakeChange = useCallback((make: string) => {
    setFields((f) => ({ ...f, make, model: '' }))
  }, [])

  if (mode === 'saving') {
    return (
      <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-white font-semibold">Saving &amp; syncing…</p>
      </main>
    )
  }

  if (mode === 'done') {
    const outcome     = syncOutcome?.outcome
    const isSuccess   = outcome === 'synced'
    const isPending   = outcome === 'pending_invoice_assignment'
    const isDuplicate = outcome === 'needs_review'

    // Parse the line text to get vehicle fields for display
    // Format: "Year Make Model | Color | Stock #"
    const lineParts    = syncOutcome?.lineText?.split(' | ') ?? []
    const vehicleLabel = lineParts[0] ?? [fields.year, fields.make, fields.model].filter(Boolean).join(' ')
    const colorLabel   = lineParts[1] ?? fields.color
    const stockLabel   = lineParts[2] ?? fields.stockNumber

    return (
      <main className="min-h-screen bg-gray-950 flex flex-col">

        {/* Result card */}
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6">

          {/* Icon */}
          <div className={`w-20 h-20 rounded-full flex items-center justify-center text-3xl font-bold
            ${isSuccess   ? 'bg-green-900/60 border-2 border-green-600 text-green-400' :
              isPending   ? 'bg-orange-900/60 border-2 border-orange-600 text-orange-400' :
              isDuplicate ? 'bg-yellow-900/60 border-2 border-yellow-600 text-yellow-400' :
                            'bg-red-900/60 border-2 border-red-700 text-red-400'}`}
          >
            {isSuccess ? '✓' : isPending ? '⏳' : isDuplicate ? '!' : '✕'}
          </div>

          {/* Headline */}
          <div className="text-center">
            <h1 className={`text-2xl font-bold
              ${isSuccess   ? 'text-green-300' :
                isPending   ? 'text-orange-300' :
                isDuplicate ? 'text-yellow-300' :
                              'text-red-300'}`}
            >
              {isSuccess   ? 'Vehicle Added'          :
               isPending   ? 'Saved — No Active Batch' :
               isDuplicate ? 'Possible Duplicate'      :
                             'Saved'}
            </h1>

            {isSuccess ? (
              <p className="text-gray-400 text-sm mt-1">Successfully added to the invoice</p>
            ) : isPending ? (
              <p className="text-gray-400 text-sm mt-1 max-w-xs text-center">
                This vehicle has been saved and will be added to an invoice when one is set up.
              </p>
            ) : isDuplicate ? (
              <p className="text-gray-400 text-sm mt-1 max-w-xs text-center">
                This stock number may already be on the invoice. It has been saved for review.
              </p>
            ) : (
              <p className="text-gray-400 text-sm mt-1">Entry saved. See supervisor if this keeps happening.</p>
            )}
          </div>

          {/* Vehicle details card */}
          <div className="w-full max-w-sm bg-gray-800 border border-gray-700 rounded-2xl p-5 space-y-3">
            {syncOutcome?.dealershipName && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Dealership</span>
                <span className="text-white font-medium">{syncOutcome.dealershipName}</span>
              </div>
            )}
            {isSuccess && syncOutcome?.invoiceNumber && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Invoice</span>
                <span className="text-white font-mono font-medium">{syncOutcome.invoiceNumber}</span>
              </div>
            )}
            {vehicleLabel && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Vehicle</span>
                <span className="text-white font-medium text-right">{vehicleLabel}</span>
              </div>
            )}
            {colorLabel && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Color</span>
                <span className="text-white">{colorLabel}</span>
              </div>
            )}
            {stockLabel && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Stock #</span>
                <span className="text-white font-mono font-bold">{stockLabel}</span>
              </div>
            )}
          </div>

        </div>

        {/* Actions — always visible at bottom */}
        <div className="px-6 pb-10 pt-4 shrink-0 space-y-3">
          <button
            onClick={() => router.push('/vehicle-entry/capture')}
            className="w-full py-5 rounded-2xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-bold text-xl transition-colors shadow-lg"
          >
            Scan Next Vehicle
          </button>
          <button
            onClick={() => router.push('/')}
            className="w-full py-3 rounded-2xl text-gray-500 hover:text-gray-300 text-sm transition-colors"
          >
            Return to Pitt Stop OS
          </button>
        </div>

      </main>
    )
  }

  const hasCrop = !!entry.stockNumberCropUrl

  // ── Review mode ─────────────────────────────────────────────────────────────
  if (mode === 'review') {
    const vinEntry = isVINEntry(entry)
    return (
      <main className="min-h-screen bg-gray-950 flex flex-col">
        <div className="flex items-center justify-between px-5 pt-6 pb-2">
          <button
            onClick={() => router.push(vinEntry ? '/vehicle-entry/vin' : '/vehicle-entry')}
            className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
          >
            {vinEntry ? '← VIN scan' : '← Retake'}
          </button>
          <div className="flex items-center gap-2">
            <span className="text-white font-semibold">Confirm Entry</span>
            {vinEntry && (
              <span className="bg-purple-900/60 border border-purple-700 text-purple-300 text-xs px-2 py-0.5 rounded-full font-medium">
                VIN
              </span>
            )}
          </div>
          <div className="w-14" />
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-32">
          {isPhotoEntry(entry) && (
            <div className="mt-3 mb-5 rounded-2xl overflow-hidden bg-gray-900 aspect-[4/3]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/vehicle-entry/entries/${entry.id}/photo`}
                alt="Key tag"
                className="w-full h-full object-cover"
              />
            </div>
          )}

          {/* VIN entry context — dealership + VIN number */}
          {vinEntry && (entry.dealershipName || entry.vin) && (
            <div className="mb-4 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 flex flex-col gap-1 text-sm">
              {entry.dealershipName && (
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 w-20 shrink-0">Source</span>
                  <span className="text-gray-200 font-medium">{entry.dealershipName}</span>
                </div>
              )}
              {entry.vin && (
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 w-20 shrink-0">VIN</span>
                  <span className="text-gray-400 font-mono text-xs tracking-wide">{entry.vin}</span>
                </div>
              )}
            </div>
          )}

          {hasLowConfidence && (
            <div className="mb-4 bg-yellow-900/40 border border-yellow-700/60 rounded-xl px-4 py-3 text-xs text-yellow-300">
              ⚠ One or more fields need verification — check the highlighted fields below.
            </div>
          )}

          <div className="space-y-3">
            <Field label="Year"    value={entry.year}   confidence={conf.year}  />
            <Field label="Make"    value={entry.make}   confidence={conf.make}  />
            <Field label="Model"   value={entry.model}  confidence={conf.model} />
            <Field label="Color"   value={entry.color}  confidence={conf.color} />
            <Field label="Stock #" value={entry.stockNumber} confidence={conf.stockNumber} />
          </div>

          {/* Debug panel — key-tag entries only */}
          {!vinEntry && (
            <div className="mt-4">
              <StockDebugPanel entry={entry} />
            </div>
          )}
        </div>

        <div className="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur px-5 py-4 border-t border-gray-800 grid grid-cols-2 gap-3">
          <button
            onClick={() => setMode('edit')}
            className="py-4 rounded-xl border border-gray-600 text-gray-200 font-semibold hover:border-gray-400 active:bg-gray-800 transition-colors"
          >
            Fix Something
          </button>
          <button
            onClick={() => submit(false)}
            className="py-4 rounded-xl bg-green-600 hover:bg-green-500 active:bg-green-700 text-white font-bold transition-colors"
          >
            Looks Right ✓
          </button>
        </div>
      </main>
    )
  }

  // ── Edit mode ───────────────────────────────────────────────────────────────
  const models    = getModelsForMake(fields.make)
  const vinEntry  = isVINEntry(entry)

  function editBackAction() {
    if (startInEditMode) return router.push('/vehicle-entry')
    setMode('review')
  }

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      <div className="flex items-center justify-between px-5 pt-6 pb-2">
        <button
          onClick={editBackAction}
          className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
        >
          ← {startInEditMode ? 'Back' : 'Cancel'}
        </button>
        <div className="flex items-center gap-2">
          <span className="text-white font-semibold">
            {startInEditMode ? 'Manual Entry' : 'Edit Entry'}
          </span>
          {vinEntry && (
            <span className="bg-purple-900/60 border border-purple-700 text-purple-300 text-xs px-2 py-0.5 rounded-full font-medium">
              VIN
            </span>
          )}
        </div>
        <div className="w-14" />
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-32 mt-4">
        <div className="space-y-4">
          <Select
            label="Year"
            value={fields.year}
            options={YEARS}
            onChange={(v) => setFields((f) => ({ ...f, year: v }))}
          />
          <Select
            label="Make"
            value={fields.make}
            options={MAKES}
            onChange={handleMakeChange}
          />
          <Select
            label="Model"
            value={fields.model}
            options={models}
            onChange={(v) => setFields((f) => ({ ...f, model: v }))}
            placeholder={fields.make ? 'Select Model' : 'Select Make first'}
          />
          <Select
            label="Color"
            value={fields.color}
            options={COLORS as unknown as string[]}
            onChange={(v) => setFields((f) => ({ ...f, color: v, customColor: '' }))}
          />
          {fields.color === 'Other' && (
            <div className="space-y-1">
              <label className="text-gray-400 text-xs uppercase tracking-wide">
                Custom Color
              </label>
              <input
                type="text"
                value={fields.customColor}
                onChange={(e) => setFields((f) => ({ ...f, customColor: e.target.value }))}
                placeholder="Describe the color"
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          {/* Stock number — show padded crop above input */}
          <div className="space-y-2">
            <label className="text-gray-400 text-xs uppercase tracking-wide block">Stock #</label>
            {hasCrop && (
              <div className="rounded-xl overflow-hidden bg-gray-900 border border-gray-700">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/vehicle-entry/entries/${entry.id}/stock-crop`}
                  alt="Stock number crop"
                  className="w-full object-contain max-h-24"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                />
              </div>
            )}
            {stockLowConf && entry.stockNumberAiPrediction && (
              <div className="text-xs text-yellow-400 px-1">
                AI read: <span className="font-mono">{entry.stockNumberAiPrediction}</span>
                {' '}— verify against the crop above
              </div>
            )}
            <input
              ref={stockInputRef}
              type="text"
              value={fields.stockNumber}
              onChange={(e) => setFields((f) => ({ ...f, stockNumber: e.target.value }))}
              placeholder="e.g. PS1234"
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-3 text-base font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {/* VIN escape — only for key-tag entries where AI couldn't read the stock # */}
            {!vinEntry && stockLowConf && (
              <a
                href="/vehicle-entry/vin"
                className="block text-center text-gray-500 text-xs underline pt-1"
              >
                Tag unreadable? Scan VIN instead →
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur px-5 py-4 border-t border-gray-800">
        <button
          onClick={() => submit(true, fields)}
          disabled={!fields.year || !fields.make || !fields.model || !fields.color}
          className="w-full py-4 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg transition-colors"
        >
          Save Corrections ✓
        </button>
      </div>
    </main>
  )
}
