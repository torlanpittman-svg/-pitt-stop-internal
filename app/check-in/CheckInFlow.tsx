'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'

// ── Types ─────────────────────────────────────────────────────────────────────

type VinData = {
  vin:       string
  year?:     string
  make?:     string
  model?:    string
  bodyClass?: string
}

type ServiceFocus = 'interior_only' | 'exterior_only' | 'full_detail' | 'custom'

type Step = 'vin' | 'confirm' | 'service'

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeVin(raw: string): string {
  return raw.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '')
}

// ── VIN Step ──────────────────────────────────────────────────────────────────

function VinStep({
  onDecoded,
  onSkip,
}: {
  onDecoded: (data: VinData) => void
  onSkip:    () => void
}) {
  const [vin,     setVin]     = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const inputRef              = useRef<HTMLInputElement>(null)

  const clean = normalizeVin(vin)

  const decode = useCallback(async () => {
    if (clean.length !== 17) {
      setError('VIN must be exactly 17 characters')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch('/api/workflow/vin', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ vin: clean }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'VIN lookup failed'); return }
      onDecoded(data)
    } catch {
      setError('Network error — check connection and try again')
    } finally {
      setLoading(false)
    }
  }, [clean, onDecoded])

  return (
    <div className="flex flex-col flex-1 px-6 pt-12 pb-8">
      <button
        onClick={() => window.history.back()}
        className="text-gray-500 text-sm mb-8 self-start"
      >
        ← Back
      </button>

      <h1 className="text-white font-bold text-2xl mb-1">Enter VIN</h1>
      <p className="text-gray-500 text-sm mb-8">
        Scan the barcode or type the 17-character VIN
      </p>

      <input
        ref={inputRef}
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={17}
        value={vin}
        onChange={e => { setVin(e.target.value); setError(null) }}
        placeholder="1HGBH41JXMN109186"
        className="w-full bg-gray-900 border border-gray-700 text-white text-xl font-mono tracking-widest rounded-2xl px-5 py-4 outline-none focus:border-blue-500 placeholder:text-gray-700 mb-2"
      />

      <div className="flex items-center justify-between mb-6">
        <span className={`text-sm ${clean.length === 17 ? 'text-green-400' : 'text-gray-600'}`}>
          {clean.length}/17
        </span>
        {error && <span className="text-red-400 text-sm">{error}</span>}
      </div>

      <button
        onClick={decode}
        disabled={clean.length !== 17 || loading}
        className="w-full bg-blue-600 text-white font-bold text-xl py-5 rounded-2xl active:bg-blue-700 disabled:opacity-40 transition-colors mb-4"
      >
        {loading ? 'Looking up…' : 'Decode VIN'}
      </button>

      <button
        onClick={onSkip}
        className="w-full text-gray-500 text-base py-3"
      >
        Enter manually without VIN
      </button>
    </div>
  )
}

// ── Confirm Step ──────────────────────────────────────────────────────────────

const COLORS = [
  'White', 'Black', 'Silver', 'Gray', 'Red', 'Blue', 'Green',
  'Brown', 'Tan', 'Gold', 'Orange', 'Yellow', 'Other',
]

function ConfirmStep({
  decoded,
  onConfirm,
  onBack,
}: {
  decoded:   Partial<VinData> & { vin?: string }
  onConfirm: (data: Partial<VinData> & { color: string }) => void
  onBack:    () => void
}) {
  const [year,  setYear]  = useState(decoded.year  ?? '')
  const [make,  setMake]  = useState(decoded.make  ?? '')
  const [model, setModel] = useState(decoded.model ?? '')
  const [color, setColor] = useState('')

  const canConfirm = (year || make || model) && color

  return (
    <div className="flex flex-col flex-1 px-6 pt-12 pb-8">
      <button onClick={onBack} className="text-gray-500 text-sm mb-8 self-start">
        ← Back
      </button>

      <h1 className="text-white font-bold text-2xl mb-1">Confirm Vehicle</h1>
      {decoded.vin && (
        <p className="text-gray-600 text-sm font-mono mb-8">{decoded.vin}</p>
      )}

      <div className="space-y-3 mb-6">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-gray-500 text-xs mb-1 block">Year</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              value={year}
              onChange={e => setYear(e.target.value)}
              placeholder="2022"
              className="w-full bg-gray-900 border border-gray-700 text-white rounded-xl px-3 py-3 text-base outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-gray-500 text-xs mb-1 block">Make</label>
            <input
              type="text"
              value={make}
              onChange={e => setMake(e.target.value)}
              placeholder="Ford"
              className="w-full bg-gray-900 border border-gray-700 text-white rounded-xl px-3 py-3 text-base outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-gray-500 text-xs mb-1 block">Model</label>
            <input
              type="text"
              value={model}
              onChange={e => setModel(e.target.value)}
              placeholder="F-150"
              className="w-full bg-gray-900 border border-gray-700 text-white rounded-xl px-3 py-3 text-base outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      <div className="mb-8">
        <label className="text-gray-500 text-xs mb-2 block">Color</label>
        <div className="grid grid-cols-4 gap-2">
          {COLORS.map(c => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`py-3 rounded-xl text-sm font-medium transition-colors ${
                color === c
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-900 border border-gray-700 text-gray-400 active:bg-gray-800'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => onConfirm({ ...decoded, year, make, model, color })}
        disabled={!canConfirm}
        className="w-full bg-blue-600 text-white font-bold text-xl py-5 rounded-2xl active:bg-blue-700 disabled:opacity-40 transition-colors"
      >
        Looks Right
      </button>
    </div>
  )
}

// ── Service Step ──────────────────────────────────────────────────────────────

const SERVICE_OPTIONS: { id: ServiceFocus; label: string; sub: string }[] = [
  { id: 'full_detail',   label: 'Full Detail',   sub: 'Interior + Exterior' },
  { id: 'interior_only', label: 'Interior Only',  sub: 'Vacuum, wipe, clean' },
  { id: 'exterior_only', label: 'Exterior Only',  sub: 'Wash, clay, protect' },
  { id: 'custom',        label: 'Custom',         sub: 'Define in notes'     },
]

function ServiceStep({
  vehicle,
  onCheckIn,
  onBack,
}: {
  vehicle:   Partial<VinData> & { color: string }
  onCheckIn: (focus: ServiceFocus, checkedInBy: string) => void
  onBack:    () => void
}) {
  const [focus,       setFocus]       = useState<ServiceFocus | null>(null)
  const [checkedInBy, setCheckedInBy] = useState('')
  const [loading,     setLoading]     = useState(false)

  const vehicleName = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'

  return (
    <div className="flex flex-col flex-1 px-6 pt-12 pb-8">
      <button onClick={onBack} className="text-gray-500 text-sm mb-8 self-start">
        ← Back
      </button>

      <h1 className="text-white font-bold text-2xl mb-0.5">Select Service</h1>
      <p className="text-gray-500 text-sm mb-8">
        {vehicleName} · {vehicle.color}
      </p>

      <div className="space-y-3 mb-8">
        {SERVICE_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => setFocus(opt.id)}
            className={`w-full text-left px-5 py-4 rounded-2xl border transition-colors ${
              focus === opt.id
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-gray-900 border-gray-800 text-white active:bg-gray-800'
            }`}
          >
            <p className="font-bold text-lg">{opt.label}</p>
            <p className={`text-sm ${focus === opt.id ? 'text-blue-200' : 'text-gray-500'}`}>
              {opt.sub}
            </p>
          </button>
        ))}
      </div>

      <div className="mb-6">
        <label className="text-gray-500 text-xs mb-1 block">Your name</label>
        <input
          type="text"
          value={checkedInBy}
          onChange={e => setCheckedInBy(e.target.value)}
          placeholder="Who is checking this in?"
          className="w-full bg-gray-900 border border-gray-700 text-white rounded-xl px-4 py-3 text-base outline-none focus:border-blue-500"
        />
      </div>

      <button
        onClick={() => {
          if (!focus || !checkedInBy.trim() || loading) return
          setLoading(true)
          onCheckIn(focus, checkedInBy.trim())
        }}
        disabled={!focus || !checkedInBy.trim() || loading}
        className="w-full bg-green-600 text-white font-bold text-xl py-5 rounded-2xl active:bg-green-700 disabled:opacity-40 transition-colors"
      >
        {loading ? 'Checking in…' : 'Check In Vehicle'}
      </button>
    </div>
  )
}

// ── Root Flow ─────────────────────────────────────────────────────────────────

export default function CheckInFlow() {
  const router = useRouter()

  const [step,    setStep]    = useState<Step>('vin')
  const [decoded, setDecoded] = useState<Partial<VinData>>({})
  const [confirmed, setConfirmed] = useState<(Partial<VinData> & { color: string }) | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  const handleDecoded = useCallback((data: VinData) => {
    setDecoded(data)
    setStep('confirm')
  }, [])

  const handleSkip = useCallback(() => {
    setDecoded({})
    setStep('confirm')
  }, [])

  const handleConfirm = useCallback((data: Partial<VinData> & { color: string }) => {
    setConfirmed(data)
    setStep('service')
  }, [])

  const handleCheckIn = useCallback(async (focus: ServiceFocus, checkedInBy: string) => {
    if (!confirmed) return
    setError(null)
    try {
      const res = await fetch('/api/workflow/orders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vin:          confirmed.vin,
          year:         confirmed.year,
          make:         confirmed.make,
          model:        confirmed.model,
          color:        confirmed.color,
          bodyClass:    confirmed.bodyClass,
          source:       confirmed.vin ? 'vin_scan' : 'walk_in',
          serviceFocus: focus,
          checkedInBy,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Check-in failed'); return }
      router.push(`/orders/${data.order.id}`)
    } catch {
      setError('Network error — try again')
    }
  }, [confirmed, router])

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      {error && (
        <div className="mx-4 mt-4 bg-red-900/40 border border-red-700 rounded-xl px-4 py-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {step === 'vin' && (
        <VinStep onDecoded={handleDecoded} onSkip={handleSkip} />
      )}
      {step === 'confirm' && (
        <ConfirmStep
          decoded={decoded}
          onConfirm={handleConfirm}
          onBack={() => setStep('vin')}
        />
      )}
      {step === 'service' && confirmed && (
        <ServiceStep
          vehicle={confirmed}
          onCheckIn={handleCheckIn}
          onBack={() => setStep('confirm')}
        />
      )}
    </main>
  )
}
