'use client'

import { useState, useEffect, useCallback } from 'react'
import PhotoInput from '@/app/components/PhotoInput'
import { useRouter } from 'next/navigation'
import { validateVIN, buildStockNumber } from '@/apps/vehicle-entry/vin'
import type { VINDecodeResult } from '@/apps/vehicle-entry/vin'
import type { DealershipRow } from '@/apps/vehicle-entry/db'

const COLORS = [
  'Black', 'White', 'Silver', 'Gray',
  'Red', 'Blue', 'Green', 'Brown',
  'Tan', 'Gold', 'Orange', 'Yellow',
  'Purple', 'Other',
] as const

const COLOR_SWATCH: Record<string, string> = {
  Black: '#111111', White: '#f0f0f0', Silver: '#c0c0c0', Gray: '#6b7280',
  Red: '#dc2626',   Blue: '#1d4ed8',  Green: '#16a34a',  Brown: '#92400e',
  Tan: '#c9a96e',   Gold: '#d4a017',  Orange: '#ea580c', Yellow: '#eab308',
  Purple: '#7c3aed', Other: '#374151',
}

type Step = 'vin' | 'details' | 'saving'

export default function VINEntry() {
  const router = useRouter()

  const [step,           setStep]           = useState<Step>('vin')
  const [vinInput,       setVinInput]       = useState('')
  const [vinError,       setVinError]       = useState<string | null>(null)
  const [loading,        setLoading]        = useState(false)
  const [decoded,        setDecoded]        = useState<VINDecodeResult | null>(null)
  const [dealerships,    setDealerships]    = useState<DealershipRow[] | null>(null)
  const [selectedDealer, setSelectedDealer] = useState<DealershipRow | null>(null)
  const [color,          setColor]          = useState('')
  const [submitError,    setSubmitError]    = useState<string | null>(null)

  // Pre-fetch dealerships so they're instant when employee reaches step 2
  useEffect(() => {
    fetch('/api/vehicle-entry/dealerships')
      .then(r => r.json())
      .then((data: DealershipRow[]) => setDealerships(Array.isArray(data) ? data : []))
      .catch(() => setDealerships([]))
  }, [])

  // ── Decode VIN (text path) ─────────────────────────────────────────────────
  const decodeVIN = useCallback(async (vin: string) => {
    setLoading(true)
    setVinError(null)
    try {
      const res  = await fetch('/api/vehicle-entry/vin', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ vin }),
      })
      const data = await res.json() as { error?: string } & Partial<VINDecodeResult>
      if (!res.ok) { setVinError(data.error ?? 'Lookup failed'); return }
      setDecoded(data as VINDecodeResult)
      setStep('details')
    } catch {
      setVinError('Network error — check your connection')
    } finally {
      setLoading(false)
    }
  }, [])

  // ── VIN photo scan (same OCR for both Take Photo and Upload Photo) ─────────
  const runVinScan = useCallback(async (file: File) => {
    setLoading(true)
    setVinError(null)
    const fd = new FormData()
    fd.append('vinImage', file, file.name)

    try {
      const res  = await fetch('/api/vehicle-entry/vin', { method: 'POST', body: fd })
      const data = await res.json() as { error?: string } & Partial<VINDecodeResult>
      if (!res.ok) {
        setVinError(data.error ?? 'Could not read VIN — type it below')
        return
      }
      setVinInput(data.vin ?? '')
      setDecoded(data as VINDecodeResult)
      setStep('details')
    } catch {
      setVinError('Network error — try typing the VIN manually')
    } finally {
      setLoading(false)
    }
  }, [])

  // ── VIN text input — strip invalid chars, auto-uppercase ──────────────────
  const handleVINInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const clean = e.target.value
      .toUpperCase()
      .replace(/[^A-HJ-NPR-Z0-9]/g, '')
      .slice(0, 17)
    setVinInput(clean)
    setVinError(null)
    if (clean.length === 17) {
      const { valid, error } = validateVIN(clean)
      if (!valid) setVinError(error ?? 'Invalid VIN')
    }
  }, [])

  // ── Create entry ───────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!decoded || !selectedDealer || !color) return
    setStep('saving')
    setSubmitError(null)
    try {
      const res  = await fetch('/api/vehicle-entry/vin-entry', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          vin:            decoded.vin,
          year:           decoded.year,
          make:           decoded.make,
          model:          decoded.model,
          color,
          dealershipId:   selectedDealer.id,
          dealershipName: selectedDealer.name,
          stockPrefix:    selectedDealer.stockPrefix,
        }),
      })
      const data = await res.json() as { id?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to create entry')
      router.push(`/vehicle-entry/confirm/${data.id}`)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong')
      setStep('details')
    }
  }, [decoded, selectedDealer, color, router])

  // ── SAVING ─────────────────────────────────────────────────────────────────
  if (step === 'saving') {
    return (
      <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-400 text-sm">Creating entry…</p>
      </main>
    )
  }

  // ── VIN INPUT ──────────────────────────────────────────────────────────────
  if (step === 'vin') {
    const isValid = vinInput.length === 17 && !vinError && validateVIN(vinInput).valid

    return (
      <main className="min-h-screen bg-gray-950 flex flex-col">
        <div className="flex items-center justify-between px-5 pt-5 pb-4 shrink-0">
          <button
            onClick={() => router.push('/vehicle-entry')}
            className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
          >
            ← Key tag scan
          </button>
          <span className="text-white font-semibold">VIN Scan</span>
          <div className="w-24" />
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-10 space-y-5">
          {/* Photo VIN scan — Take Photo or Upload Photo, same OCR */}
          <div className="space-y-1">
            <p className="text-gray-400 text-sm text-center">Scan the VIN sticker — or type it below</p>
            <PhotoInput onCapture={(file) => runVinScan(file)} continueLabel="Scan VIN" busy={loading} />
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-800" />
            <span className="text-gray-600 text-xs uppercase tracking-widest">or type manually</span>
            <div className="flex-1 h-px bg-gray-800" />
          </div>

          {/* Text input */}
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
                  : 'border-gray-600'
              }`}
            />
            <div className="flex items-center justify-between px-1">
              {vinError ? (
                <span className="text-red-400 text-xs">{vinError}</span>
              ) : (
                <span className="text-gray-600 text-xs">
                  {vinInput.length === 17 ? '✓ Valid VIN format' : 'Letters I, O, Q are never in a VIN'}
                </span>
              )}
              <span className={`text-xs tabular-nums font-mono ${vinInput.length === 17 ? 'text-green-500' : 'text-gray-500'}`}>
                {vinInput.length} / 17
              </span>
            </div>
          </div>

          <button
            onClick={() => decodeVIN(vinInput)}
            disabled={!isValid || loading}
            className="w-full py-4 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg transition-colors"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Looking up VIN…
              </span>
            ) : 'Look up VIN →'}
          </button>
        </div>
      </main>
    )
  }

  // ── DETAILS ────────────────────────────────────────────────────────────────
  const stockPreview  = selectedDealer && decoded
    ? buildStockNumber(selectedDealer.stockPrefix, decoded.vin)
    : null
  const vehicleLabel  = [decoded?.year, decoded?.make, decoded?.model].filter(Boolean).join(' ')
  const canSubmit     = !!selectedDealer && !!color

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      <div className="flex items-center justify-between px-5 pt-5 pb-4 shrink-0">
        <button
          onClick={() => { setStep('vin'); setSelectedDealer(null); setColor('') }}
          className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
        >
          ← Back
        </button>
        <span className="text-white font-semibold">VIN Entry</span>
        <div className="w-14" />
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-40 space-y-6">

        {/* Decoded vehicle info */}
        <div className="bg-gray-800 border border-gray-700 rounded-2xl p-4">
          <div className="text-green-400 text-xs font-semibold mb-1 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
            VIN DECODED
          </div>
          {vehicleLabel ? (
            <div className="text-white text-xl font-bold">{vehicleLabel}</div>
          ) : (
            <div className="text-yellow-400 text-sm">
              Make / model not found — you can correct on the next screen
            </div>
          )}
          <div className="text-gray-500 text-xs font-mono mt-2 tracking-wide">{decoded?.vin}</div>
        </div>

        {/* Dealership selection */}
        <div className="space-y-3">
          <div className="text-gray-300 text-sm font-semibold uppercase tracking-wide">
            Source Dealership
          </div>

          {dealerships === null ? (
            <div className="flex items-center gap-2 text-gray-500 text-sm py-3">
              <div className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
              Loading…
            </div>
          ) : dealerships.length === 0 ? (
            <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl px-4 py-4 text-sm text-yellow-300 text-center">
              No dealerships configured.{' '}
              <a href="/admin/vehicle-entry/dealerships" className="underline font-medium">
                Set them up in Admin →
              </a>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {dealerships.map(d => {
                const isSelected = selectedDealer?.id === d.id
                const previewStock = buildStockNumber(d.stockPrefix, decoded!.vin)
                return (
                  <button
                    key={d.id}
                    onClick={() => setSelectedDealer(d)}
                    className={`text-left p-4 rounded-2xl border-2 transition-all ${
                      isSelected
                        ? 'border-blue-500 bg-blue-900/30'
                        : 'border-gray-700 bg-gray-800 hover:border-gray-500'
                    }`}
                  >
                    {isSelected && (
                      <div className="text-blue-400 text-xs font-semibold mb-1">✓ Selected</div>
                    )}
                    <div className="text-white font-bold leading-tight">{d.name}</div>
                    <div className="text-gray-400 text-xs font-mono mt-1">{previewStock}</div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Color selection */}
        <div className="space-y-3">
          <div className="text-gray-300 text-sm font-semibold uppercase tracking-wide">
            Vehicle Color
          </div>
          <div className="grid grid-cols-4 gap-2">
            {COLORS.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`flex flex-col items-center gap-1.5 py-3 rounded-xl border-2 transition-colors ${
                  color === c
                    ? 'border-blue-500 bg-blue-900/30'
                    : 'border-gray-700 bg-gray-800'
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

        {submitError && (
          <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
            {submitError}
          </div>
        )}
      </div>

      {/* Fixed bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur border-t border-gray-800 px-5 py-4 space-y-3">
        {/* Live stock number preview */}
        {stockPreview && (
          <div className="flex items-center justify-between">
            <span className="text-gray-500 text-sm">Stock #</span>
            <span className="text-white font-bold text-xl font-mono tracking-wider">{stockPreview}</span>
          </div>
        )}
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full py-5 rounded-2xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg transition-colors"
        >
          {!selectedDealer
            ? 'Select a dealership above'
            : !color
            ? 'Select a color above'
            : 'Create Entry →'}
        </button>
      </div>
    </main>
  )
}
