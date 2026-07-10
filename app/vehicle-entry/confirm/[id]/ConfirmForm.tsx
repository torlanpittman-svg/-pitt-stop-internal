'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { YEARS, MAKES, COLORS, getModelsForMake } from '@/apps/vehicle-entry/vehicle-data'
import type { VehicleEntryRow } from '@/apps/vehicle-entry/db'

// Confidence thresholds
const HIGH = 0.85
const MID  = 0.60

function borderClass(value: string | null, c: number | undefined): string {
  if (!value)       return 'border-l-red-600'
  if ((c ?? 0) >= HIGH) return 'border-l-green-600'
  if ((c ?? 0) >= MID)  return 'border-l-yellow-500'
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

// ── Read-only field ───────────────────────────────────────────────────────────
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

// ── Select wrapper ────────────────────────────────────────────────────────────
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

// ── Main component ────────────────────────────────────────────────────────────
type Mode = 'review' | 'edit' | 'saving'

export default function ConfirmForm({
  entry,
  startInEditMode = false,
}: {
  entry: VehicleEntryRow
  startInEditMode?: boolean
}) {
  const router = useRouter()
  const [mode, setMode]   = useState<Mode>(startInEditMode ? 'edit' : 'review')
  const [fields, setFields] = useState({
    year:        entry.year        ?? '',
    make:        entry.make        ?? '',
    model:       entry.model       ?? '',
    color:       entry.color       ?? '',
    customColor: entry.customColor ?? '',
    stockNumber: entry.stockNumber ?? '',
  })

  const conf = (entry.ocrConfidence ?? {}) as Record<string, number>

  const hasLowConfidence =
    Object.values(conf).some((c) => c < MID) ||
    !entry.year ||
    !entry.make ||
    !entry.model ||
    !entry.color ||
    !entry.stockNumber

  const submit = useCallback(
    async (corrected: boolean, overrideFields?: typeof fields) => {
      setMode('saving')
      const data = overrideFields ?? fields
      await fetch(`/api/vehicle-entry/entries/${entry.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year:         data.year        || null,
          make:         data.make        || null,
          model:        data.model       || null,
          color:        data.color       || null,
          customColor:  data.customColor || null,
          stockNumber:  data.stockNumber || null,
          wasCorrected: corrected,
          status:       'ready_for_quickbooks',
        }),
      })
      router.push('/vehicle-entry?success=1')
    },
    [entry.id, fields, router]
  )

  const handleMakeChange = useCallback((make: string) => {
    setFields((f) => ({ ...f, make, model: '' }))
  }, [])

  // ── Saving state ────────────────────────────────────────────────────────────
  if (mode === 'saving') {
    return (
      <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-white font-semibold">Saving entry…</p>
      </main>
    )
  }

  // ── Review mode ─────────────────────────────────────────────────────────────
  if (mode === 'review') {
    return (
      <main className="min-h-screen bg-gray-950 flex flex-col">
        <div className="flex items-center justify-between px-5 pt-6 pb-2">
          <button
            onClick={() => router.push('/vehicle-entry')}
            className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
          >
            ← Retake
          </button>
          <span className="text-white font-semibold">Confirm Entry</span>
          <div className="w-14" />
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-32">
          {/* Key tag photo — omitted for manual entries */}
          {!entry.photoUrl.startsWith('manual://') && !entry.photoUrl.startsWith('test://') && (
            <div className="mt-3 mb-5 rounded-2xl overflow-hidden bg-gray-900 aspect-[4/3]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/vehicle-entry/entries/${entry.id}/photo`}
                alt="Key tag"
                className="w-full h-full object-cover"
              />
            </div>
          )}

          {hasLowConfidence && (
            <div className="mb-4 bg-yellow-900/40 border border-yellow-700/60 rounded-xl px-4 py-3 text-xs text-yellow-300">
              ⚠ One or more fields need verification — check the highlighted fields below.
            </div>
          )}

          <div className="space-y-3">
            <Field label="Year"         value={entry.year}        confidence={conf.year}        />
            <Field label="Make"         value={entry.make}        confidence={conf.make}        />
            <Field label="Model"        value={entry.model}       confidence={conf.model}       />
            <Field label="Color"        value={entry.color}       confidence={conf.color}       />
            <Field label="Stock #"      value={entry.stockNumber} confidence={conf.stockNumber} />
          </div>
        </div>

        {/* Fixed bottom buttons */}
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
  const models = getModelsForMake(fields.make)

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      <div className="flex items-center justify-between px-5 pt-6 pb-2">
        <button
          onClick={() => startInEditMode ? router.push('/vehicle-entry') : setMode('review')}
          className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
        >
          ← {startInEditMode ? 'Back' : 'Cancel'}
        </button>
        <span className="text-white font-semibold">
          {startInEditMode ? 'Manual Entry' : 'Edit Entry'}
        </span>
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
          <div className="space-y-1">
            <label className="text-gray-400 text-xs uppercase tracking-wide">Stock #</label>
            <input
              type="text"
              value={fields.stockNumber}
              onChange={(e) => setFields((f) => ({ ...f, stockNumber: e.target.value }))}
              placeholder="e.g. PS1234"
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-3 text-base font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
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
