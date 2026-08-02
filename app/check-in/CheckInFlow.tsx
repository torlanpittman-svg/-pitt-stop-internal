'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import PhotoInput from '@/app/components/PhotoInput'

// ── Types ─────────────────────────────────────────────────────────────────────

type VinData = {
  vin:        string
  year?:      string | null
  make?:      string | null
  model?:     string | null
  bodyClass?: string | null
}

type OcrResponse = {
  vin:       string
  confirmed: boolean
  note?:     string | null
  year?:     string | null
  make?:     string | null
  model?:    string | null
  bodyClass?: string | null
}

type ServiceFocus = 'interior_only' | 'exterior_only' | 'full_detail' | 'custom'

type FlowStep = 'scan' | 'manual' | 'confirm' | 'service'

// scanning     = live camera, barcode loop active
// found        = live barcode hit, calling NHTSA (auto-advance)
// uploading    = processing a picked image (barcode → OCR)
// vin_detected = VIN found from image, user reviews before advancing
// decoding     = calling NHTSA after user confirms uploaded VIN
// error        = something failed
type ScanState = 'scanning' | 'found' | 'uploading' | 'vin_detected' | 'decoding' | 'error'

// ── Barcode helpers ───────────────────────────────────────────────────────────

function isVin(raw: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(raw)
}

function cleanVin(raw: string): string {
  return raw.replace(/[^A-HJ-NPR-Z0-9]/gi, '').toUpperCase()
}

const BARCODE_FORMATS = ['code_39', 'code_128', 'qr_code', 'data_matrix', 'pdf417']

function makeDetector() {
  if (!('BarcodeDetector' in window)) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (window as any).BarcodeDetector({ formats: BARCODE_FORMATS })
}

async function barcodeFromBitmap(source: ImageBitmapSource): Promise<string | null> {
  const detector = makeDetector()
  if (!detector) return null
  try {
    const bitmap   = await createImageBitmap(source as Blob)
    const barcodes = await detector.detect(bitmap)
    for (const bc of barcodes) {
      const raw = cleanVin(bc.rawValue)
      if (isVin(raw)) return raw
    }
  } catch { /* unsupported or no barcode */ }
  return null
}

async function ocrVinFromFile(file: File): Promise<OcrResponse | { error: string }> {
  const form = new FormData()
  form.append('vinImage', file)
  const res  = await fetch('/api/workflow/vin', { method: 'POST', body: form })
  const data = await res.json()
  if (res.ok) return data as OcrResponse
  return { error: data.error ?? 'Could not read VIN from photo' }
}

async function decodeVin(vin: string): Promise<VinData | { error: string }> {
  const res  = await fetch('/api/workflow/vin', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ vin }),
  })
  const data = await res.json()
  if (res.ok) return data as VinData
  return { error: data.error ?? 'VIN lookup failed' }
}

// ── VIN Scanner ───────────────────────────────────────────────────────────────

function VinScanner({ onDecoded, onManual }: {
  onDecoded: (data: VinData) => void
  onManual:  () => void
}) {
  const videoRef    = useRef<HTMLVideoElement>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const scanningRef = useRef(true)
  const rafRef      = useRef<number>(0)

  const [camReady,      setCamReady]      = useState(false)
  const [camFailed,     setCamFailed]     = useState(false)
  const [scanState,     setScanState]     = useState<ScanState>('scanning')
  const [statusMsg,     setStatusMsg]     = useState<string | null>(null)
  const [detectedVin,   setDetectedVin]   = useState('')              // raw VIN from image
  const [editedVin,     setEditedVin]     = useState('')              // user-editable copy
  const [vinNote,       setVinNote]       = useState<string | null>(null)  // correction note
  const [ocrDecoded,    setOcrDecoded]    = useState<OcrResponse | null>(null) // cached OCR result

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

  // ── Live barcode scan loop (only while in 'scanning' state) ─────────────────

  const handleLiveVin = useCallback(async (raw: string) => {
    scanningRef.current = false
    cancelAnimationFrame(rafRef.current)
    setScanState('found')
    setStatusMsg('VIN detected — looking up vehicle…')

    const result = await decodeVin(raw)
    if ('error' in result) {
      setScanState('error')
      setStatusMsg(result.error)
    } else {
      onDecoded(result)
    }
  }, [onDecoded])

  useEffect(() => {
    if (!camReady || scanState !== 'scanning') return

    scanningRef.current = true
    const detector = makeDetector()
    if (!detector) return

    async function scan() {
      if (!scanningRef.current || !videoRef.current) return
      try {
        const barcodes = await detector.detect(videoRef.current)
        for (const bc of barcodes) {
          const raw = cleanVin(bc.rawValue)
          if (isVin(raw)) { handleLiveVin(raw); return }
        }
      } catch { /* per-frame errors are normal */ }
      rafRef.current = requestAnimationFrame(scan)
    }

    rafRef.current = requestAnimationFrame(scan)
    return () => {
      scanningRef.current = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [camReady, scanState, handleLiveVin])

  // ── Image upload handler ─────────────────────────────────────────────────────

  const handleUpload = useCallback(async (file: File) => {
    scanningRef.current = false
    cancelAnimationFrame(rafRef.current)
    setScanState('uploading')
    setStatusMsg('Reading VIN from photo…')

    // Try barcode detection first (fast, no API call)
    const barcode = await barcodeFromBitmap(file)
    if (barcode) {
      setDetectedVin(barcode)
      setEditedVin(barcode)
      setScanState('vin_detected')
      setStatusMsg(null)
      return
    }

    // Fall back to GPT-4.1 OCR
    const ocr = await ocrVinFromFile(file)
    if ('error' in ocr) {
      setScanState('error')
      setStatusMsg(ocr.error)
      return
    }

    setDetectedVin(ocr.vin)
    setEditedVin(ocr.vin)
    setVinNote(ocr.note ?? null)
    setOcrDecoded(ocr)
    setScanState('vin_detected')
    setStatusMsg(null)
  }, [])

  // ── Confirm the uploaded/detected VIN ────────────────────────────────────────

  const confirmDetectedVin = useCallback(async () => {
    const vin = cleanVin(editedVin)
    if (!isVin(vin)) return
    setScanState('decoding')
    setStatusMsg('Looking up vehicle…')

    // If the VIN was not edited and we have cached OCR data with vehicle info,
    // skip the second NHTSA call and use what we already decoded.
    if (vin === cleanVin(detectedVin) && ocrDecoded && (ocrDecoded.make || ocrDecoded.year)) {
      onDecoded({
        vin,
        year:      ocrDecoded.year      ?? undefined,
        make:      ocrDecoded.make      ?? undefined,
        model:     ocrDecoded.model     ?? undefined,
        bodyClass: ocrDecoded.bodyClass ?? undefined,
      })
      return
    }

    const result = await decodeVin(vin)
    if ('error' in result) {
      setScanState('error')
      setStatusMsg(result.error)
    } else {
      onDecoded(result)
    }
  }, [editedVin, detectedVin, ocrDecoded, onDecoded])

  const resetToScanning = useCallback(() => {
    setScanState('scanning')
    setStatusMsg(null)
    setDetectedVin('')
    setEditedVin('')
    setVinNote(null)
    setOcrDecoded(null)
  }, [])

  // ── Camera-failed fallback ───────────────────────────────────────────────────

  if (camFailed) {
    return (
      <div className="flex flex-col flex-1 px-6 pt-12 pb-8">
        <button onClick={() => window.history.back()} className="text-gray-500 text-sm mb-8 self-start">
          ← Back
        </button>
        <h1 className="text-white font-bold text-2xl mb-2">Check In Vehicle</h1>
        <p className="text-gray-500 text-sm mb-8">
          Camera unavailable — upload a photo of the VIN barcode or sticker.
        </p>

        {(scanState === 'uploading' || scanState === 'decoding') && (
          <div className="flex flex-col items-center py-10 gap-4">
            <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400">{statusMsg}</p>
          </div>
        )}

        {scanState === 'vin_detected' && (
          <VinReviewPanel
            editedVin={editedVin}
            detectedVin={detectedVin}
            note={vinNote}
            onChange={setEditedVin}
            onConfirm={confirmDetectedVin}
            onRetry={resetToScanning}
            onManual={onManual}
          />
        )}

        {scanState === 'error' && (
          <div className="mb-8">
            <p className="text-red-400 text-sm mb-6 text-center">{statusMsg}</p>
            <button
              onClick={resetToScanning}
              className="w-full bg-gray-800 border border-gray-700 text-white font-semibold py-4 rounded-2xl mb-3"
            >
              Try a Different Photo
            </button>
          </div>
        )}

        {(scanState === 'scanning' || scanState === 'error') && (
          <>
            <div className="mb-3">
              <PhotoInput uploadOnly normalize={false} uploadLabel="Upload VIN Photo" onCapture={(f) => handleUpload(f)} />
            </div>
            <button onClick={onManual} className="w-full text-gray-500 text-base py-3 text-center">
              Enter VIN Manually
            </button>
          </>
        )}
      </div>
    )
  }

  // ── Main camera view ─────────────────────────────────────────────────────────

  const isBusy = scanState === 'found' || scanState === 'uploading' || scanState === 'decoding'

  return (
    <div className="flex flex-col flex-1 min-h-0">

      {/* Viewfinder */}
      <div className="relative flex-1 overflow-hidden bg-black min-h-0">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline muted autoPlay
        />

        {/* Targeting overlay */}
        {camReady && scanState === 'scanning' && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-x-8 top-[30%] h-28 rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.52)]" />
            <div className="absolute left-8  top-[30%]              w-5 h-5 border-t-2 border-l-2 border-blue-400" />
            <div className="absolute right-8 top-[30%]              w-5 h-5 border-t-2 border-r-2 border-blue-400" />
            <div className="absolute left-8  top-[calc(30%+6.5rem)] w-5 h-5 border-b-2 border-l-2 border-blue-400" />
            <div className="absolute right-8 top-[calc(30%+6.5rem)] w-5 h-5 border-b-2 border-r-2 border-blue-400" />
          </div>
        )}

        {/* Camera initializing */}
        {!camReady && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 border-4 border-white/40 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {/* Processing overlay */}
        {isBusy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center px-8">
              <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-white font-semibold text-lg">{statusMsg}</p>
            </div>
          </div>
        )}

        {/* Error overlay */}
        {scanState === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/75">
            <div className="text-center px-8">
              <p className="text-red-400 font-semibold text-lg mb-6">{statusMsg}</p>
              <button
                onClick={resetToScanning}
                className="bg-white text-gray-900 font-bold px-6 py-3 rounded-xl mb-3 block mx-auto w-full"
              >
                Try Again
              </button>
              <button onClick={onManual} className="text-gray-400 text-sm">Enter VIN Manually</button>
            </div>
          </div>
        )}

        {/* VIN review overlay (from uploaded image) */}
        {scanState === 'vin_detected' && (
          <div className="absolute inset-0 flex flex-col justify-end bg-black/75">
            <div className="bg-gray-950 rounded-t-3xl px-6 pt-6 pb-8">
              <VinReviewPanel
                editedVin={editedVin}
                detectedVin={detectedVin}
                note={vinNote}
                onChange={setEditedVin}
                onConfirm={confirmDetectedVin}
                onRetry={resetToScanning}
                onManual={onManual}
              />
            </div>
          </div>
        )}

        {/* Hint pill */}
        {camReady && scanState === 'scanning' && (
          <div className="absolute top-[calc(30%+7.5rem)] inset-x-0 flex justify-center pointer-events-none">
            <div className="bg-black/60 text-white text-sm px-4 py-2 rounded-full">
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

      {/* Bottom controls — only while actively scanning */}
      {camReady && scanState === 'scanning' && (
        <div className="bg-black shrink-0 px-6 pt-5 pb-8 space-y-3">
          <PhotoInput uploadOnly normalize={false} uploadLabel="Upload VIN Photo" onCapture={(f) => handleUpload(f)} />
          <button
            onClick={onManual}
            className="w-full text-gray-600 text-sm py-2 text-center"
          >
            Enter VIN Manually
          </button>
        </div>
      )}

    </div>
  )
}

// ── VIN Review Panel (shared between camera and no-camera flows) ──────────────

function VinReviewPanel({
  editedVin,
  detectedVin,
  note,
  onChange,
  onConfirm,
  onRetry,
  onManual,
}: {
  editedVin:   string
  detectedVin: string
  note?:       string | null
  onChange:    (v: string) => void
  onConfirm:   () => void
  onRetry:     () => void
  onManual:    () => void
}) {
  const clean      = cleanVin(editedVin)
  const isValid    = isVin(clean)
  const wasEdited  = clean !== cleanVin(detectedVin)

  return (
    <div>
      <p className="text-white font-bold text-xl mb-1">VIN Detected</p>
      <p className="text-gray-500 text-sm mb-4">
        Verify each character before continuing.
      </p>

      {note && (
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl px-4 py-3 mb-4">
          <p className="text-yellow-400 text-sm">{note}</p>
        </div>
      )}

      <input
        type="text"
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={17}
        value={editedVin}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-900 border border-gray-700 text-white text-xl font-mono tracking-widest rounded-2xl px-5 py-4 outline-none focus:border-blue-500 mb-1"
      />

      <div className="flex items-center justify-between mb-5">
        <span className={`text-sm ${isValid ? 'text-green-400' : 'text-gray-600'}`}>
          {clean.length}/17{wasEdited ? ' · edited' : ''}
        </span>
        {!isValid && clean.length > 0 && (
          <span className="text-yellow-500 text-xs">Must be exactly 17 characters</span>
        )}
      </div>

      <button
        onClick={onConfirm}
        disabled={!isValid}
        className="w-full bg-blue-600 text-white font-bold text-lg py-4 rounded-2xl active:bg-blue-700 disabled:opacity-40 transition-colors mb-3"
      >
        Confirm & Look Up
      </button>
      <button
        onClick={onRetry}
        className="w-full bg-gray-800 border border-gray-700 text-white text-base font-medium py-3.5 rounded-2xl active:bg-gray-700 mb-3"
      >
        Try a Different Photo
      </button>
      <button onClick={onManual} className="w-full text-gray-600 text-sm py-2 text-center">
        Enter VIN Manually
      </button>
    </div>
  )
}

// ── Manual VIN entry ──────────────────────────────────────────────────────────

function ManualVinEntry({ onDecoded, onBack }: {
  onDecoded: (data: VinData) => void
  onBack:    () => void
}) {
  const [vin,     setVin]     = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const clean = cleanVin(vin)

  const decode = useCallback(async () => {
    if (!isVin(clean) || loading) return
    setLoading(true)
    setError(null)
    try {
      const result = await decodeVin(clean)
      if ('error' in result) { setError(result.error); return }
      onDecoded(result)
    } catch {
      setError('Network error — check connection')
    } finally {
      setLoading(false)
    }
  }, [clean, loading, onDecoded])

  return (
    <div className="flex flex-col flex-1 px-6 pt-12 pb-8">
      <button onClick={onBack} className="text-gray-500 text-sm mb-8 self-start">
        ← Back to Scanner
      </button>
      <h1 className="text-white font-bold text-2xl mb-1">Enter VIN</h1>
      <p className="text-gray-500 text-sm mb-8">Type the 17-character Vehicle Identification Number</p>

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
        <span className={`text-sm ${isVin(clean) ? 'text-green-400' : 'text-gray-600'}`}>
          {clean.length}/17
        </span>
        {error && <span className="text-red-400 text-sm">{error}</span>}
      </div>

      <button
        onClick={decode}
        disabled={!isVin(clean) || loading}
        className="w-full bg-blue-600 text-white font-bold text-xl py-5 rounded-2xl active:bg-blue-700 disabled:opacity-40 transition-colors mb-4"
      >
        {loading ? 'Looking up…' : 'Look Up VIN'}
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

// ── Confirm vehicle step ──────────────────────────────────────────────────────

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
        {([
          { label: 'Year',  value: year,  setter: setYear,  placeholder: '2022' },
          { label: 'Make',  value: make,  setter: setMake,  placeholder: 'Ford' },
          { label: 'Model', value: model, setter: setModel, placeholder: 'F-150' },
        ] as const).map(f => (
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

// ── Service selection step ────────────────────────────────────────────────────

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
  onCheckIn: (focus: ServiceFocus) => void
  onBack:    () => void
}) {
  const [focus,   setFocus]   = useState<ServiceFocus | null>(null)
  const [loading, setLoading] = useState(false)

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

      <button
        onClick={() => {
          if (!focus || loading) return
          setLoading(true)
          onCheckIn(focus)
        }}
        disabled={!focus || loading}
        className="w-full bg-green-600 text-white font-bold text-xl py-5 rounded-2xl active:bg-green-700 disabled:opacity-40 transition-colors"
      >
        {loading ? 'Checking in…' : 'Check In Vehicle'}
      </button>
    </div>
  )
}

// ── Root flow ─────────────────────────────────────────────────────────────────

export default function CheckInFlow() {
  const router = useRouter()

  const [step,      setStep]      = useState<FlowStep>('scan')
  const [decoded,   setDecoded]   = useState<Partial<VinData>>({})
  const [confirmed, setConfirmed] = useState<(Partial<VinData> & { color: string }) | null>(null)
  const [error,     setError]     = useState<string | null>(null)

  const handleDecoded = useCallback((data: VinData) => {
    setDecoded(data)
    setStep('confirm')
  }, [])

  const handleConfirm = useCallback((data: Partial<VinData> & { color: string }) => {
    setConfirmed(data)
    setStep('service')
  }, [])

  const handleCheckIn = useCallback(async (focus: ServiceFocus) => {
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

      {step === 'scan' && (
        <VinScanner
          onDecoded={handleDecoded}
          onManual={() => setStep('manual')}
        />
      )}

      {step === 'manual' && (
        <ManualVinEntry
          onDecoded={handleDecoded}
          onBack={() => setStep('scan')}
        />
      )}

      {step === 'confirm' && (
        <ConfirmStep
          decoded={decoded}
          onConfirm={handleConfirm}
          onBack={() => setStep('scan')}
        />
      )}

      {step === 'service' && confirmed && (
        <ServiceStep
          vehicle={confirmed}
          onCheckIn={(focus) => handleCheckIn(focus)}
          onBack={() => setStep('confirm')}
        />
      )}
    </main>
  )
}
