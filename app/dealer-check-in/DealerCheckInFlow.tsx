'use client'

/**
 * Dealer Check-In — camera-first, one-tap flow.
 *
 * Camera opens immediately and scans for a VIN barcode. The same frame is OCR'd
 * for stock number + color. VIN is decoded (NHTSA). Everything lands on ONE
 * confirmation screen; "Looks Good" writes the QB line + Work Board order and
 * jumps to the board. Designed for gloves + sunlight: big targets, high contrast,
 * almost no typing, graceful retake on bad scans.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const BARCODE_FORMATS = ['code_39', 'code_128', 'data_matrix', 'qr_code']
const STOCK_CONFIDENCE_MIN = 70

type Phase = 'scanning' | 'processing' | 'confirm' | 'submitting' | 'done'

interface Preview {
  ok: boolean
  dealership: { id: string; name: string; qbCustomerId: string | null } | null
  vehicle: { year?: string | null; make?: string | null; model?: string | null; color?: string | null; vin?: string | null; stockNumber?: string | null }
  linePreview: string
  pricing: { promptRequired: boolean; signals: string[]; standardRate: number; newVehicleRate: number; defaultRate: number }
  invoiceTarget: { action: 'append' | 'create'; invoiceNumber?: string | null }
  duplicate: { reason: string; existingInvoiceNumber?: string | null; existingOrderId?: string } | null
  warnings: string[]
}

interface Captured {
  vin: string | null
  year: string | null
  make: string | null
  model: string | null
  color: string | null
  stockNumber: string | null
  stockConfidence: number | null
  tagColor: 'white' | 'yellow' | null
}

function makeDetector(): { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } | null {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (window as any).BarcodeDetector({ formats: BARCODE_FORMATS })
  } catch {
    return null
  }
}

export default function DealerCheckInFlow() {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const scanningRef = useRef(true)

  const [phase, setPhase] = useState<Phase>('scanning')
  const [camReady, setCamReady] = useState(false)
  const [camFailed, setCamFailed] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [captured, setCaptured] = useState<Captured | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [newVehicle, setNewVehicle] = useState(false) // $125 toggle
  const [error, setError] = useState<string | null>(null)
  const [writeResult, setWriteResult] = useState<
    { outcome: string; invoiceNumber: string | null; action?: string; serviceOrderId: string } | null
  >(null)
  const startedAt = useRef<number>(0)
  const handleCaptureRef = useRef<(vin?: string) => void>(() => {})
  const submittingRef = useRef(false) // guards against duplicate production writes

  const captureFrame = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const v = videoRef.current
      if (!v) return resolve(null)
      const canvas = document.createElement('canvas')
      canvas.width = v.videoWidth
      canvas.height = v.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(v, 0, 0)
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9)
    })
  }, [])

  // ── Camera + live barcode scanning (single stable interval) ─────────────────
  useEffect(() => {
    let cancelled = false
    const detector = makeDetector()
    let intervalId: ReturnType<typeof setInterval> | null = null

    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera unavailable')
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        const v = videoRef.current!
        v.srcObject = stream
        await v.play()
        setCamReady(true)
        startedAt.current = Date.now()

        if (detector) {
          intervalId = setInterval(async () => {
            if (!scanningRef.current || !videoRef.current || videoRef.current.readyState < 2) return
            try {
              const codes = await detector.detect(videoRef.current)
              const vinCode = codes.map((c) => c.rawValue.trim().toUpperCase()).find((x) => /^[A-HJ-NPR-Z0-9]{17}$/.test(x))
              if (vinCode) { scanningRef.current = false; handleCaptureRef.current(vinCode) }
            } catch { /* keep scanning */ }
          }, 350)
        }
      } catch {
        setCamFailed(true)
      }
    })()

    return () => {
      cancelled = true
      scanningRef.current = false
      if (intervalId) clearInterval(intervalId)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const runPreview = useCallback(async (cap: Captured, isNewVehicle: boolean) => {
    setStatus('Checking QuickBooks…')
    const res = await fetch('/api/dealer-checkin/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cap, tagColor: isNewVehicle ? 'white' : 'yellow' }),
    })
    const p = (await res.json()) as Preview
    setPreview(p)
    setPhase('confirm')
  }, [])

  // ── Capture → OCR + VIN decode + preview ────────────────────────────────────
  const handleCapture = useCallback(async (vinFromBarcode?: string) => {
    scanningRef.current = false
    setPhase('processing')
    setError(null)
    setStatus('Reading tag…')
    try {
      const blob = await captureFrame()

      // OCR the tag for stock + color (+ fallback vehicle fields)
      let ocr: Partial<Captured> & { stockConfidence?: number | null } = {}
      if (blob) {
        const form = new FormData()
        form.append('tagImage', new File([blob], 'tag.jpg', { type: 'image/jpeg' }))
        const res = await fetch('/api/dealer-checkin/ocr', { method: 'POST', body: form })
        if (res.ok) {
          const d = await res.json()
          ocr = { stockNumber: d.stockNumber, color: d.color, year: d.year, make: d.make, model: d.model, stockConfidence: d.stockConfidence }
        }
      }

      // Decode VIN (barcode preferred; else OCR the frame for a VIN)
      let vinData: { vin: string | null; year: string | null; make: string | null; model: string | null } = { vin: vinFromBarcode ?? null, year: null, make: null, model: null }
      if (vinFromBarcode) {
        setStatus('Decoding VIN…')
        const res = await fetch('/api/workflow/vin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vin: vinFromBarcode }),
        })
        if (res.ok) { const d = await res.json(); vinData = { vin: d.vin ?? vinFromBarcode, year: d.year, make: d.make, model: d.model } }
      } else if (blob) {
        setStatus('Reading VIN…')
        const form = new FormData()
        form.append('vinImage', new File([blob], 'vin.jpg', { type: 'image/jpeg' }))
        const res = await fetch('/api/workflow/vin', { method: 'POST', body: form })
        if (res.ok) { const d = await res.json(); vinData = { vin: d.vin ?? null, year: d.year, make: d.make, model: d.model } }
      }

      const cap: Captured = {
        vin: vinData.vin,
        year: vinData.year ?? ocr.year ?? null,
        make: vinData.make ?? ocr.make ?? null,
        model: vinData.model ?? ocr.model ?? null,
        color: ocr.color ?? null,
        stockNumber: ocr.stockNumber ?? null,
        stockConfidence: ocr.stockConfidence ?? null,
        tagColor: null,
      }
      setCaptured(cap)

      if (!cap.stockNumber && !cap.vin) {
        setError('Could not read the tag. Move closer and hold steady.')
        setPhase('scanning'); scanningRef.current = true; return
      }

      await runPreview(cap, false)
    } catch (err) {
      setError(String(err))
      setPhase('scanning'); scanningRef.current = true
    }
  }, [captureFrame, runPreview])

  // Keep the interval's capture handler pointing at the latest closure.
  useEffect(() => { handleCaptureRef.current = handleCapture }, [handleCapture])

  const retake = useCallback(() => {
    setPreview(null); setCaptured(null); setError(null); setNewVehicle(false); setWriteResult(null)
    setPhase('scanning'); scanningRef.current = true
  }, [])

  // ── Confirm the production write ("Confirm Production Write") ────────────────
  // Sends the explicit X-QB-Write-Approved header — the only path that authorizes
  // a real QuickBooks invoice write. Guarded against duplicate submissions.
  const confirm = useCallback(async (force = false) => {
    if (!captured || !preview?.dealership) return
    if (submittingRef.current) return // prevent duplicate submissions (double-tap)
    submittingRef.current = true
    setPhase('submitting'); setError(null)
    const rate = newVehicle ? preview.pricing.newVehicleRate : undefined
    try {
      const res = await fetch('/api/dealer-checkin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-QB-Write-Approved': 'true', // explicit, operator-approved production write
        },
        body: JSON.stringify({
          ...captured, tagColor: newVehicle ? 'white' : 'yellow',
          rate, force,
          approvedBy: 'operator', // recorded on the scan audit trail as the approver
          scanDurationMs: Date.now() - startedAt.current,
        }),
      })
      const result = await res.json()
      if (result.ok && result.serviceOrderId) {
        // Report exactly what happened — a real QB write vs. a queued one.
        setWriteResult({
          outcome:       result.outcome,
          invoiceNumber: result.invoice?.number ?? null,
          action:        result.invoice?.action,
          serviceOrderId: result.serviceOrderId,
        })
        setPhase('done')
        return
      }
      if (result.outcome === 'duplicate' && !force) {
        setPreview((p) => p ? { ...p, duplicate: result.duplicate ?? p.duplicate } : p)
        setPhase('confirm'); return
      }
      setError(result.error || `Could not complete (${result.outcome}). Try again.`)
      setPhase('confirm')
    } catch {
      // QB/network failure — keep the operator's work, offer retry
      setError('QuickBooks unreachable. Your scan is saved — tap Retry.')
      setPhase('confirm')
    } finally {
      submittingRef.current = false
    }
  }, [captured, preview, newVehicle, router])

  // ── UI ──────────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <header className="flex items-center gap-2 px-4 py-3 text-sm shrink-0">
        <Link href="/" className="text-gray-500">← Pitt Stop</Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-300 font-medium">Dealer Check-In</span>
      </header>

      {(phase === 'scanning' || phase === 'processing') && (
        <div className="relative flex-1 flex flex-col">
          <div className="relative flex-1 bg-gray-950 overflow-hidden">
            <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
            {/* scan frame — portrait guide sized for a vertical dealer tag.
                Camera feed is untouched; only this overlay changes. */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-3/5 max-w-[15rem] aspect-[3/5] max-h-[80%] border-4 border-white/80 rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
            </div>
            {!camReady && !camFailed && (
              <div className="absolute inset-0 flex items-center justify-center text-gray-400">Opening camera…</div>
            )}
            {camFailed && (
              <div className="absolute inset-0 flex items-center justify-center text-center px-8 text-gray-300">
                Camera unavailable. Allow camera access and reload.
              </div>
            )}
            {phase === 'processing' && (
              <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-3">
                <div className="w-10 h-10 border-3 border-white/30 border-t-white rounded-full animate-spin" />
                <p className="text-lg">{status ?? 'Working…'}</p>
              </div>
            )}
          </div>
          <div className="p-4 space-y-3 shrink-0">
            {error && <p className="text-amber-400 text-center text-sm">{error}</p>}
            <p className="text-center text-gray-400 text-sm">Frame the tag vertically in the box — VIN scans automatically</p>
            <button
              onClick={() => handleCapture()}
              disabled={!camReady || phase === 'processing'}
              className="w-full h-16 rounded-2xl bg-white text-black text-xl font-bold disabled:opacity-40"
            >
              Capture Tag
            </button>
          </div>
        </div>
      )}

      {phase === 'confirm' && preview && (
        <ConfirmScreen
          preview={preview}
          captured={captured!}
          newVehicle={newVehicle}
          onToggleNewVehicle={(v) => {
            setNewVehicle(v)
            if (captured) void runPreview(captured, v)
          }}
          error={error}
          onLooksGood={() => confirm(false)}
          onCheckInAnyway={() => confirm(true)}
          onRetake={retake}
        />
      )}

      {phase === 'submitting' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin" />
          <p className="text-xl">Writing to QuickBooks…</p>
        </div>
      )}

      {phase === 'done' && writeResult && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          {writeResult.outcome === 'queued' ? (
            <>
              <div className="text-5xl">⚠️</div>
              <p className="text-2xl font-bold text-amber-300">Queued — not in QuickBooks yet</p>
              <p className="text-gray-400 max-w-sm">
                The vehicle is on the Work Board, but QuickBooks was unavailable so the invoice is
                <span className="text-amber-300 font-semibold"> queued</span> and will sync automatically.
                No invoice exists in QuickBooks yet.
              </p>
            </>
          ) : (
            <>
              <div className="text-5xl text-green-400">✓</div>
              <p className="text-2xl font-bold">
                Invoice {writeResult.action === 'appended' ? 'updated' : 'created'}
              </p>
              <p className="text-gray-300 max-w-sm">
                {writeResult.invoiceNumber ? (
                  <>QuickBooks invoice <span className="font-bold text-white">#{writeResult.invoiceNumber}</span> — added to Work Board.</>
                ) : (
                  <span className="text-amber-300">Written to QuickBooks, but no invoice number was returned — please verify in QuickBooks.</span>
                )}
              </p>
            </>
          )}
          <button
            onClick={() => router.push(`/work-board?new=${writeResult.serviceOrderId}`)}
            className="mt-4 w-full max-w-xs h-14 rounded-2xl bg-white text-black text-lg font-bold"
          >
            View Work Board
          </button>
        </div>
      )}
    </main>
  )
}

function ConfirmScreen({
  preview, captured, newVehicle, onToggleNewVehicle, error, onLooksGood, onCheckInAnyway, onRetake,
}: {
  preview: Preview
  captured: Captured
  newVehicle: boolean
  onToggleNewVehicle: (v: boolean) => void
  error: string | null
  onLooksGood: () => void
  onCheckInAnyway: () => void
  onRetake: () => void
}) {
  const rate = newVehicle ? preview.pricing.newVehicleRate : preview.pricing.defaultRate
  const isAutoGroup = preview.dealership?.name === 'Sterling Auto Group'
  const showPricingToggle = preview.pricing.promptRequired || isAutoGroup
  const lowStock = captured.stockConfidence != null && captured.stockConfidence < STOCK_CONFIDENCE_MIN
  const canSubmit = Boolean(preview.dealership?.qbCustomerId) && !preview.duplicate

  return (
    <div className="flex-1 flex flex-col px-5 pt-2 pb-5 overflow-y-auto">
      {/* Dealer */}
      <div className="text-center mb-4">
        <p className="text-gray-500 text-xs uppercase tracking-widest">Dealer</p>
        <p className="text-2xl font-bold">{preview.dealership?.name ?? 'Unknown dealer'}</p>
      </div>

      {/* Vehicle card */}
      <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5 space-y-3">
        <Field label="Vehicle" value={[captured.year, captured.make, captured.model].filter(Boolean).join(' ') || '—'} big />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Color" value={captured.color ?? '—'} />
          <Field label="Stock #" value={captured.stockNumber ?? '—'} warn={lowStock} />
        </div>
        {captured.vin && <Field label="VIN" value={captured.vin} mono />}
      </div>

      {/* Pending QuickBooks write — the exact write awaiting approval */}
      <div className="mt-4 rounded-2xl bg-gray-900 border border-gray-800 p-4 space-y-2">
        <p className="text-gray-500 text-xs uppercase tracking-widest">Pending QuickBooks write</p>
        <div className="flex justify-between gap-3 text-sm">
          <span className="text-gray-500 shrink-0">Customer</span>
          <span className="text-white text-right">
            {preview.dealership?.name ?? '—'}
            {preview.dealership?.qbCustomerId ? ` (#${preview.dealership.qbCustomerId})` : ''}
          </span>
        </div>
        <div className="flex justify-between gap-3 text-sm">
          <span className="text-gray-500 shrink-0">Service</span>
          <span className="text-white text-right">Complete Detail</span>
        </div>
        <div className="flex justify-between gap-3 text-sm">
          <span className="text-gray-500 shrink-0">Invoice</span>
          <span className="text-white text-right">
            {preview.invoiceTarget.action === 'append'
              ? `Append to open #${preview.invoiceTarget.invoiceNumber}`
              : 'Create new invoice'}
          </span>
        </div>
        <div className="border-t border-gray-800 pt-2">
          <p className="text-base font-medium">{preview.linePreview}</p>
          <p className="text-2xl font-bold mt-0.5">${rate}</p>
        </div>
      </div>

      {/* $125 new-vehicle toggle */}
      {showPricingToggle && (
        <button
          onClick={() => onToggleNewVehicle(!newVehicle)}
          className={`mt-3 w-full h-14 rounded-2xl border-2 text-lg font-semibold transition-colors ${
            newVehicle ? 'border-green-500 bg-green-500/15 text-green-300' : 'border-gray-700 text-gray-300'
          }`}
        >
          {newVehicle ? '✓ New Sterling Auto vehicle — $125' : 'New Sterling Auto vehicle? Tap for $125'}
        </button>
      )}

      {/* Low-confidence retake hint */}
      {lowStock && (
        <p className="mt-3 text-amber-400 text-center text-sm">Stock number looks unclear — consider a retake.</p>
      )}

      {/* Assumptions & confidence */}
      {(preview.warnings.length > 0 || captured.stockConfidence != null) && (
        <div className="mt-3 rounded-2xl border border-gray-700 bg-gray-900/60 p-4">
          <p className="text-gray-400 text-xs uppercase tracking-widest mb-1.5">Assumptions</p>
          <ul className="text-gray-300 text-sm list-disc list-inside space-y-0.5">
            {captured.stockConfidence != null && (
              <li className={lowStock ? 'text-amber-400' : ''}>Stock # read confidence: {captured.stockConfidence}%</li>
            )}
            <li>Rate applied: ${rate} ({newVehicle ? 'new Sterling Auto' : 'standard detail'})</li>
            {preview.warnings.map((w, i) => (
              <li key={i} className="text-amber-300">{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Duplicate warning */}
      {preview.duplicate && (
        <div className="mt-3 rounded-2xl border border-amber-700 bg-amber-950/40 p-4">
          <p className="text-amber-300 font-semibold">Possible duplicate</p>
          <p className="text-amber-200/80 text-sm mt-1">{preview.duplicate.reason}</p>
        </div>
      )}

      {error && <p className="mt-3 text-red-400 text-center text-sm">{error}</p>}

      {/* Actions */}
      <div className="mt-auto pt-5 space-y-3">
        {canSubmit && (
          <button onClick={onLooksGood} className="w-full h-16 rounded-2xl bg-green-600 active:bg-green-700 text-white text-xl font-bold">
            Confirm Production Write
          </button>
        )}
        {preview.duplicate && (
          <button onClick={onCheckInAnyway} className="w-full h-14 rounded-2xl border border-amber-600 text-amber-300 text-lg font-semibold">
            Check In Anyway
          </button>
        )}
        <button onClick={onRetake} className="w-full h-14 rounded-2xl border border-gray-700 text-gray-300 text-lg font-semibold">
          Retake
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, big, mono, warn }: { label: string; value: string; big?: boolean; mono?: boolean; warn?: boolean }) {
  return (
    <div>
      <p className="text-gray-500 text-xs uppercase tracking-widest">{label}</p>
      <p className={`${big ? 'text-xl font-bold' : 'text-lg'} ${mono ? 'font-mono text-base' : ''} ${warn ? 'text-amber-400' : 'text-white'}`}>{value}</p>
    </div>
  )
}
