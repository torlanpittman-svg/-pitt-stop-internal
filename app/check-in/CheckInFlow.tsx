'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
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

type Step = 'scan' | 'confirm' | 'service'

// ── VIN Scanner ───────────────────────────────────────────────────────────────

type ScanState = 'scanning' | 'found' | 'capturing' | 'error'

function VinScanner({ onDecoded, onManual }: {
  onDecoded: (data: VinData) => void
  onManual:  () => void
}) {
  const videoRef    = useRef<HTMLVideoElement>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const scanningRef = useRef(true)
  const rafRef      = useRef<number>(0)

  const [camReady,   setCamReady]   = useState(false)
  const [camFailed,  setCamFailed]  = useState(false)
  const [scanState,  setScanState]  = useState<ScanState>('scanning')
  const [foundVin,   setFoundVin]   = useState<string | null>(null)
  const [statusMsg,  setStatusMsg]  = useState<string | null>(null)

  // ── Camera init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unavailable')
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        if (!live) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        const v = videoRef.current!
        v.srcObject = stream
        await v.play()
        if (live) setCamReady(true)
      } catch {
        if (live) setCamFailed(true)
      }
    }

    start()
    return () => {
      live = false
      scanningRef.current = false
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ── Barcode scan loop ───────────────────────────────────────────────────────
  const handleVinFound = useCallback(async (raw: string) => {
    scanningRef.current = false
    cancelAnimationFrame(rafRef.current)
    setFoundVin(raw)
    setScanState('found')
    setStatusMsg('VIN detected — looking up vehicle…')

    try {
      const res  = await fetch('/api/workflow/vin', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ vin: raw }),
      })
      const data = await res.json()
      if (res.ok) {
        onDecoded(data)
      } else {
        setScanState('error')
        setStatusMsg(data.error ?? 'VIN lookup failed')
      }
    } catch {
      setScanState('error')
      setStatusMsg('Network error — check connection')
    }
  }, [onDecoded])

  useEffect(() => {
    if (!camReady) return

    const detector = 'BarcodeDetector' in window
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? new (window as any).BarcodeDetector({ formats: ['code_39', 'code_128', 'qr_code', 'data_matrix', 'pdf417'] })
      : null

    if (!detector) return // no native barcode support — user taps capture or types

    async function scan() {
      if (!scanningRef.current || !videoRef.current) return
      try {
        const barcodes = await detector.detect(videoRef.current)
        for (const bc of barcodes) {
          const raw = bc.rawValue.replace(/[^A-HJ-NPR-Z0-9]/gi, '').toUpperCase()
          if (raw.length === 17) {
            handleVinFound(raw)
            return
          }
        }
      } catch { /* ignore per-frame errors */ }
      rafRef.current = requestAnimationFrame(scan)
    }

    rafRef.current = requestAnimationFrame(scan)
    return () => cancelAnimationFrame(rafRef.current)
  }, [camReady, handleVinFound])

  // ── Photo OCR capture ───────────────────────────────────────────────────────
  const captureAndOcr = useCallback(async () => {
    const video = videoRef.current
    if (!video || scanState !== 'scanning') return

    scanningRef.current = false
    cancelAnimationFrame(rafRef.current)
    setScanState('capturing')
    setStatusMsg('Reading VIN from photo…')

    try {
      const canvas = document.createElement('canvas')
      const scale  = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight))
      canvas.width  = Math.round(video.videoWidth  * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)

      const blob = await new Promise<Blob>((res, rej) =>
        canvas.toBlob(b => b ? res(b) : rej(new Error('export failed')), 'image/jpeg', 0.88)
      )

      const form = new FormData()
      form.append('vinImage', new File([blob], 'vin.jpg', { type: 'image/jpeg' }))

      const apiRes = await fetch('/api/workflow/vin', { method: 'POST', body: form })
      const data   = await apiRes.json()

      if (apiRes.ok) {
        onDecoded(data)
      } else {
        setScanState('error')
        setStatusMsg(data.error ?? 'Could not read VIN from photo')
      }
    } catch {
      setScanState('error')
      setStatusMsg('Photo capture failed — try again')
    }
  }, [scanState, onDecoded])

  const retry = useCallback(() => {
    setStatusMsg(null)
    setFoundVin(null)
    setScanState('scanning')
    scanningRef.current = true
    // restart scan loop — effect will re-fire on next camReady state change
    // instead trigger manually:
    const detector = 'BarcodeDetector' in window
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? new (window as any).BarcodeDetector({ formats: ['code_39', 'code_128', 'qr_code', 'data_matrix', 'pdf417'] })
      : null

    if (!detector || !videoRef.current) return

    async function scan() {
      if (!scanningRef.current || !videoRef.current) return
      try {
        const barcodes = await detector.detect(videoRef.current)
        for (const bc of barcodes) {
          const raw = bc.rawValue.replace(/[^A-HJ-NPR-Z0-9]/gi, '').toUpperCase()
          if (raw.length === 17) { handleVinFound(raw); return }
        }
      } catch {}
      rafRef.current = requestAnimationFrame(scan)
    }
    rafRef.current = requestAnimationFrame(scan)
  }, [handleVinFound])

  // ── Camera failed — show file input fallback ────────────────────────────────
  if (camFailed) {
    return (
      <div className="flex flex-col flex-1 px-6 pt-12 pb-8">
        <button onClick={() => window.history.back()} className="text-gray-500 text-sm mb-8 self-start">← Back</button>
        <h1 className="text-white font-bold text-2xl mb-2">Scan VIN</h1>
        <p className="text-gray-500 text-sm mb-8">Camera unavailable — upload a photo of the VIN or barcode.</p>

        <label className="w-full bg-blue-600 text-white font-bold text-xl py-5 rounded-2xl text-center block cursor-pointer active:bg-blue-700 mb-4">
          Upload VIN Photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={async e => {
              const file = e.target.files?.[0]
              if (!file) return
              setScanState('capturing')
              setStatusMsg('Reading VIN from photo…')
              const form = new FormData()
              form.append('vinImage', file)
              const res  = await fetch('/api/workflow/vin', { method: 'POST', body: form })
              const data = await res.json()
              if (res.ok) { onDecoded(data) } else { setScanState('error'); setStatusMsg(data.error ?? 'Failed') }
            }}
          />
        </label>

        <button onClick={onManual} className="text-gray-500 text-base py-3 text-center">
          Type VIN Manually
        </button>

        {statusMsg && <p className="text-red-400 text-sm text-center mt-4">{statusMsg}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">

      {/* Viewfinder */}
      <div className="relative flex-1 overflow-hidden bg-black min-h-0">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline muted autoPlay
        />

        {/* Dim overlay with clear targeting window */}
        {camReady && scanState === 'scanning' && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-0 bg-black/50" />
            {/* Clear rectangle cut-out via clip */}
            <div className="absolute inset-x-8 top-[30%] h-28 rounded-xl border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]" />
            <div className="absolute inset-x-8 top-[30%] h-28 rounded-xl overflow-hidden">
              <div className="absolute inset-0 bg-transparent" />
            </div>
            {/* Corner accents */}
            <div className="absolute left-8 top-[30%] w-5 h-5 border-t-2 border-l-2 border-blue-400 rounded-tl" />
            <div className="absolute right-8 top-[30%] w-5 h-5 border-t-2 border-r-2 border-blue-400 rounded-tr" />
            <div className="absolute left-8 bottom-[calc(70%-7rem)] w-5 h-5 border-b-2 border-l-2 border-blue-400 rounded-bl" />
            <div className="absolute right-8 bottom-[calc(70%-7rem)] w-5 h-5 border-b-2 border-r-2 border-blue-400 rounded-br" />
          </div>
        )}

        {/* Scanning spinner / status */}
        {!camReady && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 border-4 border-white/40 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {/* Found / processing state */}
        {(scanState === 'found' || scanState === 'capturing') && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center px-8">
              <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-white font-semibold text-lg">{statusMsg}</p>
              {foundVin && <p className="text-blue-300 font-mono text-sm mt-2">{foundVin}</p>}
            </div>
          </div>
        )}

        {/* Error state */}
        {scanState === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center px-8">
              <p className="text-red-400 font-semibold text-lg mb-6">{statusMsg}</p>
              <button
                onClick={retry}
                className="bg-white text-gray-900 font-bold px-6 py-3 rounded-xl mb-3 block mx-auto"
              >
                Try Again
              </button>
              <button onClick={onManual} className="text-gray-400 text-sm">Type VIN Manually</button>
            </div>
          </div>
        )}

        {/* Instruction pill */}
        {camReady && scanState === 'scanning' && (
          <div className="absolute top-[calc(30%+8rem+12px)] inset-x-0 flex justify-center pointer-events-none">
            <div className="bg-black/60 text-white text-sm px-4 py-2 rounded-full text-center">
              Aim at the VIN barcode on the door jamb
            </div>
          </div>
        )}

        {/* Back button */}
        <button
          onClick={() => window.history.back()}
          className="absolute top-12 left-4 bg-black/50 text-white text-sm px-3 py-1.5 rounded-full"
        >
          ← Back
        </button>
      </div>

      {/* Bottom controls */}
      {camReady && scanState === 'scanning' && (
        <div className="bg-black shrink-0 px-6 pt-5 pb-8 space-y-3">
          <button
            onClick={captureAndOcr}
            className="w-full bg-gray-800 border border-gray-700 text-white font-semibold text-base py-4 rounded-2xl active:bg-gray-700 transition-colors"
          >
            Take Photo of VIN Instead
          </button>
          <button
            onClick={onManual}
            className="w-full text-gray-600 text-sm py-2 text-center"
          >
            Type VIN Manually
          </button>
        </div>
      )}

    </div>
  )
}

// ── Manual VIN entry (fallback) ───────────────────────────────────────────────

function ManualVinEntry({ onDecoded, onBack }: {
  onDecoded: (data: VinData) => void
  onBack:    () => void
}) {
  const [vin,     setVin]     = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const clean = vin.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '')

  const decode = useCallback(async () => {
    if (clean.length !== 17 || loading) return
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
      setError('Network error — check connection')
    } finally {
      setLoading(false)
    }
  }, [clean, loading, onDecoded])

  return (
    <div className="flex flex-col flex-1 px-6 pt-12 pb-8">
      <button onClick={onBack} className="text-gray-500 text-sm mb-8 self-start">← Back to Scanner</button>
      <h1 className="text-white font-bold text-2xl mb-1">Type VIN</h1>
      <p className="text-gray-500 text-sm mb-8">Enter the 17-character Vehicle Identification Number</p>

      <input
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
        autoFocus
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
        onClick={() => onDecoded({ vin: '' })}
        className="w-full text-gray-500 text-base py-3 text-center"
      >
        Skip — enter vehicle details manually
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
  decoded:   Partial<VinData>
  onConfirm: (data: Partial<VinData> & { color: string }) => void
  onBack:    () => void
}) {
  const [year,  setYear]  = useState(decoded.year  ?? '')
  const [make,  setMake]  = useState(decoded.make  ?? '')
  const [model, setModel] = useState(decoded.model ?? '')
  const [color, setColor] = useState('')

  const canConfirm = (year || make || model) && color

  return (
    <div className="flex flex-col flex-1 px-6 pt-12 pb-8 overflow-y-auto">
      <button onClick={onBack} className="text-gray-500 text-sm mb-8 self-start">← Back</button>

      <h1 className="text-white font-bold text-2xl mb-1">Confirm Vehicle</h1>
      {decoded.vin && (
        <p className="text-gray-600 text-sm font-mono mb-8">{decoded.vin}</p>
      )}

      <div className="grid grid-cols-3 gap-2 mb-6">
        {[
          { label: 'Year',  value: year,  setter: setYear,  placeholder: '2022' },
          { label: 'Make',  value: make,  setter: setMake,  placeholder: 'Ford' },
          { label: 'Model', value: model, setter: setModel, placeholder: 'F-150' },
        ].map(f => (
          <div key={f.label}>
            <label className="text-gray-500 text-xs mb-1 block">{f.label}</label>
            <input
              type="text"
              value={f.value}
              onChange={e => f.setter(e.target.value)}
              placeholder={f.placeholder}
              className="w-full bg-gray-900 border border-gray-700 text-white rounded-xl px-3 py-3 text-base outline-none focus:border-blue-500"
            />
          </div>
        ))}
      </div>

      <label className="text-gray-500 text-xs mb-2 block">Color</label>
      <div className="grid grid-cols-4 gap-2 mb-8">
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
  { id: 'full_detail',   label: 'Full Detail',  sub: 'Interior + Exterior' },
  { id: 'interior_only', label: 'Interior Only', sub: 'Vacuum, wipe, clean' },
  { id: 'exterior_only', label: 'Exterior Only', sub: 'Wash, clay, protect' },
  { id: 'custom',        label: 'Custom',        sub: 'Define in notes'     },
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
    <div className="flex flex-col flex-1 px-6 pt-12 pb-8 overflow-y-auto">
      <button onClick={onBack} className="text-gray-500 text-sm mb-8 self-start">← Back</button>

      <h1 className="text-white font-bold text-2xl mb-0.5">Select Service</h1>
      <p className="text-gray-500 text-sm mb-8">{vehicleName} · {vehicle.color}</p>

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
            <p className={`text-sm ${focus === opt.id ? 'text-blue-200' : 'text-gray-500'}`}>{opt.sub}</p>
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

  const [step,      setStep]      = useState<Step>('scan')
  const [showManual, setShowManual] = useState(false)
  const [decoded,   setDecoded]   = useState<Partial<VinData>>({})
  const [confirmed, setConfirmed] = useState<(Partial<VinData> & { color: string }) | null>(null)
  const [error,     setError]     = useState<string | null>(null)

  const handleDecoded = useCallback((data: VinData) => {
    setDecoded(data)
    setShowManual(false)
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
          vin:          confirmed.vin || undefined,
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

      {step === 'scan' && !showManual && (
        <VinScanner
          onDecoded={handleDecoded}
          onManual={() => setShowManual(true)}
        />
      )}

      {step === 'scan' && showManual && (
        <ManualVinEntry
          onDecoded={handleDecoded}
          onBack={() => setShowManual(false)}
        />
      )}

      {step === 'confirm' && (
        <ConfirmStep
          decoded={decoded}
          onConfirm={handleConfirm}
          onBack={() => { setShowManual(false); setStep('scan') }}
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
