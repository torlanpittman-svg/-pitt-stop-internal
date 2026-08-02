'use client'

import { useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { validateVIN } from '@/apps/vehicle-entry/vin'
import { YEARS, MAKES, COLORS, getModelsForMake } from '@/apps/vehicle-entry/vehicle-data'
import PhotoInput from '@/app/components/PhotoInput'

// ── Constants ────────────────────────────────────────────────────────────────

const VEHICLE_SIZES = [
  'Compact Car', 'Mid-size Sedan', 'Full-size Sedan', 'Coupe',
  'Compact SUV / Crossover', 'Mid-size SUV', 'Full-size SUV (2-row)',
  'Full-size SUV (3-row)', 'Minivan', 'Compact Pickup',
  'Full-size Pickup (Crew Cab)', 'Full-size Pickup (Regular Cab)',
  'Sports Car', 'Luxury Sedan', 'Full-size Luxury SUV', 'Cargo Van', 'Exotic',
]

const COLOR_SWATCH: Record<string, string> = {
  Black: '#111111', White: '#f0f0f0', Silver: '#c0c0c0', Gray: '#6b7280',
  Red: '#dc2626',   Blue: '#1d4ed8',  Green: '#16a34a',  Brown: '#92400e',
  Tan: '#c9a96e',   Gold: '#d4a017',  Orange: '#ea580c', Yellow: '#eab308',
  Purple: '#7c3aed', Other: '#374151',
}

type DecodedVehicle = {
  vin:       string
  year:      string | null
  make:      string | null
  model:     string | null
  bodyClass: string | null
}

type Step = 'vin' | 'loading' | 'confirm' | 'manual' | 'saving'

// ── Sub-components ────────────────────────────────────────────────────────────

function StepBar({ active }: { active: number }) {
  return (
    <div className="px-5 pt-2 pb-4 shrink-0">
      <div className="flex items-center gap-2">
        {[1,2,3,4,5,6,7].map(n => (
          <div key={n} className={`h-1 flex-1 rounded-full ${n <= active ? 'bg-blue-500' : 'bg-gray-800'}`} />
        ))}
      </div>
      <p className="text-gray-500 text-xs mt-2">Step 2 of 7 — Vehicle Information</p>
    </div>
  )
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="space-y-2">
      <label className="text-gray-400 text-xs uppercase tracking-wide block">
        Vehicle Color <span className="text-red-400">*</span>
      </label>
      <div className="grid grid-cols-4 gap-2">
        {(COLORS as readonly string[]).map(c => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={`flex flex-col items-center gap-1.5 py-3 rounded-xl border-2 transition-colors ${
              value === c
                ? 'border-blue-500 bg-blue-900/30'
                : 'border-gray-700 bg-gray-800 hover:border-gray-600'
            }`}
          >
            <div
              className="w-6 h-6 rounded-full border border-gray-600 shrink-0"
              style={{ backgroundColor: COLOR_SWATCH[c] ?? '#374151' }}
            />
            <span className="text-white text-xs leading-tight text-center">{c}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function SelectField({
  label, value, options, onChange, placeholder, required,
}: {
  label: string; value: string; options: readonly string[]
  onChange: (v: string) => void; placeholder?: string; required?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-gray-400 text-xs uppercase tracking-wide">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3.5 text-base appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">{placeholder ?? `Select ${label}`}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function VehicleInfoPage() {
  const router       = useRouter()
  const { id }       = useParams<{ id: string }>()

  const [step,       setStep]       = useState<Step>('vin')
  const [vinInput,   setVinInput]   = useState('')
  const [vinError,   setVinError]   = useState<string | null>(null)
  const [decoded,    setDecoded]    = useState<DecodedVehicle | null>(null)
  const [color,      setColor]      = useState('')
  const [saveError,  setSaveError]  = useState<string | null>(null)
  const [loadMsg,    setLoadMsg]    = useState('Reading VIN…')

  // Manual-entry fields (pre-populated from VIN decode when coming from confirm)
  const [manual, setManual] = useState({
    vehicleYear:  '', vehicleMake:  '', vehicleModel: '',
    vehicleColor: '', vehicleSize:  '', vin: '',
  })

  // ── VIN decode (shared by photo and text paths) ───────────────────────────
  const handleDecodeResult = useCallback((data: DecodedVehicle) => {
    setDecoded(data)
    // Pre-fill manual fields from decode result for the Fix Something path
    setManual(m => ({
      ...m,
      vin:          data.vin,
      vehicleYear:  data.year  ?? '',
      vehicleMake:  data.make  ?? '',
      vehicleModel: data.model ?? '',
    }))
    setStep('confirm')
  }, [])

  // ── Photo VIN scan (same OCR for both Take Photo and Upload Photo) ─────────
  const runVinScan = useCallback(async (file: File) => {
    setStep('loading')
    setLoadMsg('Reading VIN from photo…')
    setVinError(null)

    const fd = new FormData()
    fd.append('vinImage', file, file.name)

    try {
      const res  = await fetch('/api/estimator/vin', { method: 'POST', body: fd })
      const data = await res.json() as DecodedVehicle & { error?: string }
      if (!res.ok) {
        setVinError(data.error ?? 'Could not read VIN')
        setStep('vin')
        return
      }
      setVinInput(data.vin ?? '')
      handleDecodeResult(data)
    } catch {
      setVinError('Network error — check your connection and try again')
      setStep('vin')
    }
  }, [handleDecodeResult])

  // ── Text VIN lookup ───────────────────────────────────────────────────────
  const handleTextLookup = useCallback(async () => {
    const { valid, error } = validateVIN(vinInput)
    if (!valid) { setVinError(error ?? 'Invalid VIN'); return }

    setStep('loading')
    setLoadMsg('Decoding VIN…')
    setVinError(null)

    try {
      const res  = await fetch('/api/estimator/vin', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ vin: vinInput }),
      })
      const data = await res.json() as DecodedVehicle & { error?: string }
      if (!res.ok) {
        setVinError(data.error ?? 'Lookup failed')
        setStep('vin')
        return
      }
      handleDecodeResult(data)
    } catch {
      setVinError('Network error — check your connection and try again')
      setStep('vin')
    }
  }, [vinInput, handleDecodeResult])

  const handleVINInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const clean = e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17)
    setVinInput(clean)
    setVinError(null)
  }, [])

  // ── Save to estimate ──────────────────────────────────────────────────────
  const saveAndContinue = useCallback(async (payload: Record<string, unknown>) => {
    setStep('saving')
    setSaveError(null)
    try {
      const res = await fetch(`/api/estimator/estimates/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to save')
      router.push(`/estimator/${id}/photos`)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
      setStep('confirm')
    }
  }, [id, router])

  // ── Confirm: approve decoded data ─────────────────────────────────────────
  const handleConfirmApprove = useCallback(() => {
    if (!decoded || !color) return
    saveAndContinue({
      vin:                 decoded.vin,
      vehicleYear:         decoded.year,
      vehicleMake:         decoded.make,
      vehicleModel:        decoded.model,
      vehicleColor:        color,
      vehicleBodyClass:    decoded.bodyClass,
      vinDecodeProvider:   'nhtsa',
      vehicleWasCorrected: false,
    })
  }, [decoded, color, saveAndContinue])

  // ── Manual: save corrected data ───────────────────────────────────────────
  const handleManualSave = useCallback(() => {
    if (!manual.vehicleYear || !manual.vehicleMake || !manual.vehicleModel || !manual.vehicleColor) return
    saveAndContinue({
      vin:                 manual.vin || null,
      vehicleYear:         manual.vehicleYear,
      vehicleMake:         manual.vehicleMake,
      vehicleModel:        manual.vehicleModel,
      vehicleColor:        manual.vehicleColor,
      vehicleSize:         manual.vehicleSize || null,
      vehicleWasCorrected: !!decoded,  // true if we had a decode but employee changed something
      vinDecodeProvider:   decoded ? 'nhtsa' : null,
    })
  }, [manual, decoded, saveAndContinue])

  const goToManual = useCallback(() => {
    // Pre-fill manual fields from decode (if any) + color selection
    setManual(m => ({
      ...m,
      vehicleColor: color || m.vehicleColor,
    }))
    setStep('manual')
  }, [color])

  // ─────────────────────────────────────────────────────────────────────────
  // LOADING
  // ─────────────────────────────────────────────────────────────────────────
  if (step === 'loading' || step === 'saving') {
    return (
      <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-400 text-sm">
          {step === 'saving' ? 'Saving…' : loadMsg}
        </p>
      </main>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VIN ENTRY
  // ─────────────────────────────────────────────────────────────────────────
  if (step === 'vin') {
    const isValidVIN = vinInput.length === 17 && !vinError && validateVIN(vinInput).valid

    return (
      <main className="min-h-screen bg-gray-950 flex flex-col">
        <div className="flex items-center justify-between px-5 pt-6 pb-2 shrink-0">
          <Link href="/estimator" className="text-gray-500 text-sm hover:text-gray-300 transition-colors">
            ← Back
          </Link>
          <span className="text-white font-semibold">Vehicle Information</span>
          <div className="w-14" />
        </div>
        <StepBar active={2} />

        <div className="flex-1 overflow-y-auto px-5 pb-32 space-y-5 pt-2">

          {/* Primary: scan a VIN photo — Take Photo or Upload Photo, same OCR */}
          <div className="space-y-1">
            <p className="text-gray-400 text-sm text-center">Scan the VIN — door jamb sticker or windshield plate</p>
            <PhotoInput onCapture={(file) => runVinScan(file)} continueLabel="Scan VIN" />
          </div>

          {/* Error banner */}
          {vinError && (
            <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3 space-y-2">
              <p className="text-red-300 text-sm font-medium">{vinError}</p>
              <button
                onClick={() => setVinError(null)}
                className="text-red-400 text-xs underline"
              >
                Try again
              </button>
            </div>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-800" />
            <span className="text-gray-600 text-xs uppercase tracking-widest">or type manually</span>
            <div className="flex-1 h-px bg-gray-800" />
          </div>

          {/* Manual VIN text entry */}
          <div className="space-y-2">
            <label className="text-gray-400 text-xs uppercase tracking-wide">
              Vehicle Identification Number (VIN)
            </label>
            <input
              type="text"
              inputMode="text"
              value={vinInput}
              onChange={handleVINInput}
              placeholder="1HGBH41JXMN109186"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className={`w-full bg-gray-800 border text-white rounded-xl px-4 py-4 text-lg font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors ${
                vinError
                  ? 'border-red-500'
                  : vinInput.length === 17 && !vinError
                  ? 'border-green-600'
                  : 'border-gray-700'
              }`}
            />
            <div className="flex items-center justify-between px-1">
              <span className={`text-xs ${vinError ? 'text-red-400' : 'text-gray-600'}`}>
                {vinError ?? (vinInput.length === 17 ? '✓ Valid format' : 'I, O, Q never appear in a VIN')}
              </span>
              <span className={`text-xs font-mono tabular-nums ${vinInput.length === 17 ? 'text-green-500' : 'text-gray-600'}`}>
                {vinInput.length}/17
              </span>
            </div>
          </div>

          <button
            onClick={handleTextLookup}
            disabled={!isValidVIN}
            className="w-full py-4 rounded-xl bg-gray-800 hover:bg-gray-700 active:bg-gray-900 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg border border-gray-700 transition-colors"
          >
            Look Up VIN →
          </button>

          {/* Skip VIN entirely */}
          <div className="text-center pt-2">
            <button
              onClick={goToManual}
              className="text-gray-600 text-sm hover:text-gray-400 transition-colors"
            >
              Skip VIN — enter vehicle details manually
            </button>
          </div>
        </div>
      </main>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIRM
  // ─────────────────────────────────────────────────────────────────────────
  if (step === 'confirm' && decoded) {
    const vehicleLabel = [decoded.year, decoded.make, decoded.model].filter(Boolean).join(' ')
    const hasFullDecode = decoded.year && decoded.make && decoded.model
    const canApprove = !!color

    return (
      <main className="min-h-screen bg-gray-950 flex flex-col">
        <div className="flex items-center justify-between px-5 pt-6 pb-2 shrink-0">
          <button
            onClick={() => setStep('vin')}
            className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
          >
            ← Try Again
          </button>
          <span className="text-white font-semibold">Confirm Vehicle</span>
          <div className="w-20" />
        </div>
        <StepBar active={2} />

        <div className="flex-1 overflow-y-auto px-5 pb-36 space-y-5 pt-2">

          {/* VIN decoded card */}
          <div className={`rounded-2xl border p-4 ${hasFullDecode
            ? 'bg-green-900/20 border-green-800'
            : 'bg-yellow-900/20 border-yellow-800'}`}
          >
            <div className={`text-xs font-semibold flex items-center gap-1.5 mb-2 ${hasFullDecode ? 'text-green-400' : 'text-yellow-400'}`}>
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${hasFullDecode ? 'bg-green-400' : 'bg-yellow-400'}`} />
              {hasFullDecode ? 'VIN DECODED' : 'PARTIAL DECODE — verify below'}
            </div>
            {vehicleLabel
              ? <p className="text-white font-bold text-xl">{vehicleLabel}</p>
              : <p className="text-yellow-300 text-sm">Year / make / model not found — fix below</p>
            }
            <p className="text-gray-500 text-xs font-mono mt-2 tracking-wider">{decoded.vin}</p>
            {decoded.bodyClass && (
              <p className="text-gray-600 text-xs mt-1">{decoded.bodyClass}</p>
            )}
          </div>

          {/* Field summary */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            {[
              { label: 'VIN',   value: decoded.vin,   mono: true },
              { label: 'Year',  value: decoded.year  ?? '—', dim: !decoded.year },
              { label: 'Make',  value: decoded.make  ?? '—', dim: !decoded.make },
              { label: 'Model', value: decoded.model ?? '—', dim: !decoded.model },
            ].map((row, i, arr) => (
              <div
                key={row.label}
                className={`flex items-center justify-between px-4 py-3 ${i < arr.length - 1 ? 'border-b border-gray-800' : ''}`}
              >
                <span className="text-gray-500 text-sm">{row.label}</span>
                <span className={`text-sm font-medium text-right max-w-[60%] truncate ${
                  row.dim ? 'text-yellow-400' : 'text-white'
                } ${row.mono ? 'font-mono text-xs tracking-wider' : ''}`}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>

          {/* Color selection */}
          <ColorPicker value={color} onChange={setColor} />

          {saveError && (
            <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
              {saveError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur px-5 py-4 border-t border-gray-800 space-y-3">
          {!color && (
            <p className="text-gray-600 text-xs text-center">Select a color above to continue</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={goToManual}
              className="py-4 rounded-xl border border-gray-600 text-gray-200 font-semibold hover:border-gray-400 active:bg-gray-800 transition-colors"
            >
              Fix Something
            </button>
            <button
              onClick={handleConfirmApprove}
              disabled={!canApprove}
              className="py-4 rounded-xl bg-green-600 hover:bg-green-500 active:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold transition-colors"
            >
              Looks Right ✓
            </button>
          </div>
        </div>
      </main>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MANUAL ENTRY (fallback)
  // ─────────────────────────────────────────────────────────────────────────
  const manualModels  = getModelsForMake(manual.vehicleMake)
  const canSaveManual = manual.vehicleYear && manual.vehicleMake && manual.vehicleModel && manual.vehicleColor

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      <div className="flex items-center justify-between px-5 pt-6 pb-2 shrink-0">
        <button
          onClick={() => decoded ? setStep('confirm') : setStep('vin')}
          className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
        >
          ← Back
        </button>
        <span className="text-white font-semibold">Enter Manually</span>
        <div className="w-14" />
      </div>
      <StepBar active={2} />

      <div className="flex-1 overflow-y-auto px-5 pb-36 space-y-4 pt-2">

        {/* VIN field (pre-filled from scan, editable) */}
        <div className="space-y-1.5">
          <label className="text-gray-400 text-xs uppercase tracking-wide">
            VIN <span className="text-gray-600 text-xs normal-case">(optional)</span>
          </label>
          <input
            type="text"
            value={manual.vin}
            onChange={e => setManual(m => ({ ...m, vin: e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17) }))}
            placeholder="17-character VIN (optional)"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3.5 text-base font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <SelectField label="Year"  value={manual.vehicleYear}  options={YEARS}
          onChange={v => setManual(m => ({ ...m, vehicleYear: v }))} required />
        <SelectField label="Make"  value={manual.vehicleMake}  options={MAKES}
          onChange={v => setManual(m => ({ ...m, vehicleMake: v, vehicleModel: '' }))} required />
        <SelectField label="Model" value={manual.vehicleModel} options={manualModels}
          onChange={v => setManual(m => ({ ...m, vehicleModel: v }))}
          placeholder={manual.vehicleMake ? 'Select Model' : 'Select Make first'} required />

        <ColorPicker
          value={manual.vehicleColor}
          onChange={v => setManual(m => ({ ...m, vehicleColor: v }))}
        />

        <SelectField label="Vehicle Size / Type" value={manual.vehicleSize} options={VEHICLE_SIZES}
          onChange={v => setManual(m => ({ ...m, vehicleSize: v }))}
          placeholder="Select size (optional)" />

        {saveError && (
          <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
            {saveError}
          </div>
        )}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur px-5 py-4 border-t border-gray-800">
        <button
          onClick={handleManualSave}
          disabled={!canSaveManual}
          className="w-full py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg transition-colors"
        >
          Continue to Photos →
        </button>
      </div>
    </main>
  )
}
