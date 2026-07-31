'use client'

/**
 * Dealer Check-In — Take Photo / Upload Photo → clean, editable review → send.
 *
 * Both entry options feed the SAME pipeline: image → /api/dealer-checkin/ocr
 * (stores the original tag image + returns OCR fields) → a clean review screen
 * where every field is editable. The employee's confirmed values are the source
 * of truth. "Confirm and Send to QuickBooks" is the ONLY path that writes, and
 * it sends X-QB-Write-Approved: true (unchanged production write flow).
 *
 * The review screen intentionally shows NO confidence scores or OCR internals.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

type Phase = 'entry' | 'camera' | 'processing' | 'review' | 'submitting' | 'done'

interface Preview {
  ok: boolean
  dealership: { id: string; name: string; qbCustomerId: string | null } | null
  vehicle: Record<string, string | null | undefined>
  linePreview: string
  pricing: { promptRequired: boolean; signals: string[]; standardRate: number; newVehicleRate: number; defaultRate: number }
  invoiceTarget: { action: 'append' | 'create'; invoiceNumber?: string | null }
  duplicate: { reason: string; existingInvoiceNumber?: string | null; existingOrderId?: string } | null
  warnings: string[]
}

interface Fields {
  stockNumber: string
  year: string
  make: string
  model: string
  color: string
}

// A stock number is a letter prefix followed by digits (e.g. K1234, S72951).
const STOCK_RE = /^[A-Za-z]{1,3}[- ]?\d{2,}$/

export default function DealerCheckInFlow() {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const submittingRef = useRef(false)
  const startedAt = useRef(0)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [phase, setPhase] = useState<Phase>('entry')
  const [camReady, setCamReady] = useState(false)
  const [camFailed, setCamFailed] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // captured image + OCR
  const [imageUrl, setImageUrl] = useState<string | null>(null) // Blob URL (or local object URL for display)
  const [storedUrl, setStoredUrl] = useState<string | null>(null) // persisted Blob URL (audit)
  const [imageHash, setImageHash] = useState<string | null>(null)
  const [rawOcr, setRawOcr] = useState<unknown>(null)
  const [ocrValues, setOcrValues] = useState<Record<string, unknown> | null>(null)
  const [vin, setVin] = useState<string | null>(null)

  // editable, employee-owned fields (source of truth)
  const [fields, setFields] = useState<Fields>({ stockNumber: '', year: '', make: '', model: '', color: '' })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [resolving, setResolving] = useState(false)
  const [newVehicle, setNewVehicle] = useState(false)
  const [priceOverride, setPriceOverride] = useState<string>('')
  const [overrideFormat, setOverrideFormat] = useState(false)

  const [writeResult, setWriteResult] = useState<
    { outcome: string; invoiceNumber: string | null; action?: string; serviceOrderId: string } | null
  >(null)

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCamReady(false)
  }, [])

  // ── Camera lifecycle (only while in the 'camera' phase) ─────────────────────
  useEffect(() => {
    if (phase !== 'camera') return
    let cancelled = false
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
      } catch {
        setCamFailed(true)
      }
    })()
    return () => { cancelled = true; stopCamera() }
  }, [phase, stopCamera])

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

  // ── Shared pipeline: image → OCR + store → review ───────────────────────────
  const processImage = useCallback(async (file: Blob) => {
    setPhase('processing'); setError(null); setStatus('Reading tag…')
    startedAt.current = Date.now()
    // instant local preview so the review screen always has an image
    const localUrl = URL.createObjectURL(file)
    setImageUrl(localUrl)
    try {
      const form = new FormData()
      form.append('tagImage', new File([file], 'tag.jpg', { type: 'image/jpeg' }))
      const res = await fetch('/api/dealer-checkin/ocr', { method: 'POST', body: form })
      const d = await res.json()
      if (!res.ok || d.ok === false) throw new Error(d.error || 'Could not read the tag')

      if (d.photoUrl) { setStoredUrl(d.photoUrl); setImageUrl(d.photoUrl) }
      setImageHash(d.imageHash ?? null)
      setRawOcr(d.rawOcr ?? null)
      const ocr = {
        stockNumber: d.stockNumber ?? '', year: d.year ?? '', make: d.make ?? '',
        model: d.model ?? '', color: d.color ?? '',
      }
      setOcrValues(ocr)
      setFields({
        stockNumber: ocr.stockNumber, year: ocr.year, make: ocr.make, model: ocr.model, color: ocr.color,
      })

      // background VIN enrichment (non-blocking) — only fills empty vehicle fields
      void enrichVin(file)

      await runPreview(ocr.stockNumber, false)
      setPhase('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('entry')
    }
  }, [])

  // Optional VIN decode from the same image — enriches year/make/model if blank.
  const enrichVin = useCallback(async (file: Blob) => {
    try {
      const form = new FormData()
      form.append('vinImage', new File([file], 'vin.jpg', { type: 'image/jpeg' }))
      const res = await fetch('/api/workflow/vin', { method: 'POST', body: form })
      if (!res.ok) return
      const d = await res.json()
      if (d.vin) setVin(d.vin)
      setFields((f) => ({
        ...f,
        year: f.year || (d.year ?? ''),
        make: f.make || (d.make ?? ''),
        model: f.model || (d.model ?? ''),
      }))
    } catch { /* enrichment is best-effort */ }
  }, [])

  // Resolve dealer + pricing + invoice target for a stock number (read-only).
  const runPreview = useCallback(async (stockNumber: string, isNewVehicle: boolean) => {
    setResolving(true)
    try {
      const res = await fetch('/api/dealer-checkin/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stockNumber, tagColor: isNewVehicle ? 'white' : 'yellow' }),
      })
      setPreview((await res.json()) as Preview)
    } catch { /* keep last preview */ } finally { setResolving(false) }
  }, [])

  // Debounced re-resolve when the stock number changes (dealer prefix may change).
  const onStockChange = useCallback((value: string) => {
    setFields((f) => ({ ...f, stockNumber: value }))
    setOverrideFormat(false)
    if (previewTimer.current) clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => { void runPreview(value, newVehicle) }, 450)
  }, [runPreview, newVehicle])

  // ── Entry actions ───────────────────────────────────────────────────────────
  const onUploadPick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (file) void processImage(file)
  }, [processImage])

  const onCapture = useCallback(async () => {
    const blob = await captureFrame()
    stopCamera()
    if (blob) void processImage(blob)
    else { setError('Capture failed — try again.'); setPhase('entry') }
  }, [captureFrame, processImage, stopCamera])

  const reset = useCallback(() => {
    setPreview(null); setError(null); setNewVehicle(false); setPriceOverride('')
    setOverrideFormat(false); setWriteResult(null); setVin(null)
    setImageUrl(null); setStoredUrl(null); setImageHash(null); setRawOcr(null); setOcrValues(null)
    setFields({ stockNumber: '', year: '', make: '', model: '', color: '' })
    setPhase('entry')
  }, [])

  // ── Confirm and Send (the only production write) ────────────────────────────
  const rate = priceOverride.trim() !== ''
    ? Number(priceOverride)
    : newVehicle ? (preview?.pricing.newVehicleRate ?? 125) : (preview?.pricing.defaultRate ?? 200)

  const confirm = useCallback(async (force = false) => {
    if (submittingRef.current) return
    if (!preview?.dealership?.qbCustomerId) { setError('No dealer matches this stock number.'); return }
    submittingRef.current = true
    setPhase('submitting'); setError(null)
    try {
      const res = await fetch('/api/dealer-checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-QB-Write-Approved': 'true' },
        body: JSON.stringify({
          stockNumber: fields.stockNumber.trim(),
          stockSource: 'manual',
          year: fields.year || null, make: fields.make || null, model: fields.model || null, color: fields.color || null,
          vin: vin ?? null,
          tagColor: newVehicle ? 'white' : 'yellow',
          rate: Number.isFinite(rate) ? rate : undefined,
          force,
          photoUrl: storedUrl, imageHash, rawOcr, ocrValues,
          approvedBy: 'operator',
          scanDurationMs: Date.now() - startedAt.current,
        }),
      })
      const result = await res.json()
      if (result.ok && result.serviceOrderId) {
        setWriteResult({
          outcome: result.outcome, invoiceNumber: result.invoice?.number ?? null,
          action: result.invoice?.action, serviceOrderId: result.serviceOrderId,
        })
        setPhase('done'); return
      }
      if (result.outcome === 'duplicate' && !force) {
        setPreview((p) => (p ? { ...p, duplicate: result.duplicate ?? p.duplicate } : p))
        setPhase('review'); return
      }
      setError(result.error || `Could not complete (${result.outcome}). Try again.`)
      setPhase('review')
    } catch {
      setError('QuickBooks unreachable. Your scan is saved — tap Retry.')
      setPhase('review')
    } finally {
      submittingRef.current = false
    }
  }, [preview, fields, vin, newVehicle, rate, storedUrl, imageHash, rawOcr, ocrValues])

  const stockValid = STOCK_RE.test(fields.stockNumber.trim())
  const dealerOk = Boolean(preview?.dealership?.qbCustomerId)
  const canSend = dealerOk && !preview?.duplicate && (stockValid || overrideFormat)
  const showPricingToggle = Boolean(preview?.pricing.promptRequired) || preview?.dealership?.name === 'Sterling Auto Group'

  // ── UI ──────────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <header className="flex items-center gap-2 px-4 py-3 text-sm shrink-0">
        <Link href="/" className="text-gray-500">← Pitt Stop</Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-300 font-medium">Dealer Check-In</span>
      </header>

      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onUploadPick} />

      {/* Entry: Take Photo / Upload Photo */}
      {phase === 'entry' && (
        <div className="flex-1 flex flex-col justify-center gap-4 px-6 pb-10">
          <p className="text-center text-gray-400 mb-2">Scan a dealer tag</p>
          {error && <p className="text-amber-400 text-center text-sm">{error}</p>}
          <button onClick={() => { setCamFailed(false); setPhase('camera') }} className="w-full h-20 rounded-2xl bg-white text-black text-xl font-bold">
            📷 Take Photo
          </button>
          <button onClick={() => fileInputRef.current?.click()} className="w-full h-20 rounded-2xl border-2 border-gray-700 text-white text-xl font-bold">
            ⬆︎ Upload Photo
          </button>
        </div>
      )}

      {/* Camera capture */}
      {phase === 'camera' && (
        <div className="relative flex-1 flex flex-col">
          <div className="relative flex-1 bg-gray-950 overflow-hidden">
            <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-3/5 max-w-[15rem] aspect-[3/5] max-h-[80%] border-4 border-white/80 rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
            </div>
            {!camReady && !camFailed && <div className="absolute inset-0 flex items-center justify-center text-gray-400">Opening camera…</div>}
            {camFailed && <div className="absolute inset-0 flex items-center justify-center text-center px-8 text-gray-300">Camera unavailable. Use Upload Photo instead.</div>}
          </div>
          <div className="p-4 space-y-3 shrink-0">
            <p className="text-center text-gray-400 text-sm">Frame the tag vertically in the box</p>
            <button onClick={onCapture} disabled={!camReady} className="w-full h-16 rounded-2xl bg-white text-black text-xl font-bold disabled:opacity-40">Capture Tag</button>
            <button onClick={() => { stopCamera(); setPhase('entry') }} className="w-full h-12 rounded-2xl border border-gray-700 text-gray-300">Cancel</button>
          </div>
        </div>
      )}

      {phase === 'processing' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <div className="w-10 h-10 border-3 border-white/30 border-t-white rounded-full animate-spin" />
          <p className="text-lg">{status ?? 'Working…'}</p>
        </div>
      )}

      {/* Review — clean, fully editable */}
      {phase === 'review' && (
        <div className="flex-1 flex flex-col px-5 pt-1 pb-5 overflow-y-auto">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {imageUrl && <img src={imageUrl} alt="Dealer tag" className="w-full max-h-56 object-contain rounded-2xl bg-gray-900 border border-gray-800 mb-4" />}

          <div className="rounded-2xl bg-gray-900 border border-gray-800 divide-y divide-gray-800">
            <Row label="Dealer" hint={resolving ? 'checking…' : undefined}>
              <span className={`text-lg font-semibold ${dealerOk ? 'text-white' : 'text-amber-400'}`}>
                {preview?.dealership?.name ?? 'Unknown dealer'}
              </span>
            </Row>
            <EditRow label="Stock Number" value={fields.stockNumber} onChange={onStockChange} autoCapitalize="characters" mono
                     warn={!stockValid && fields.stockNumber.length > 0 && !overrideFormat} />
            <div className="grid grid-cols-2 divide-x divide-gray-800">
              <EditRow label="Year" value={fields.year} onChange={(v) => setFields((f) => ({ ...f, year: v }))} inputMode="numeric" />
              <EditRow label="Make" value={fields.make} onChange={(v) => setFields((f) => ({ ...f, make: v }))} />
            </div>
            <div className="grid grid-cols-2 divide-x divide-gray-800">
              <EditRow label="Model" value={fields.model} onChange={(v) => setFields((f) => ({ ...f, model: v }))} />
              <EditRow label="Color" value={fields.color} onChange={(v) => setFields((f) => ({ ...f, color: v }))} />
            </div>
            <Row label="Service"><span className="text-lg">Complete Detail</span></Row>
            <EditRow label="Price ($)" value={priceOverride || String(rate)} onChange={setPriceOverride} inputMode="numeric" />
          </div>

          <p className="text-gray-500 text-sm mt-3">
            {preview?.invoiceTarget.action === 'append'
              ? `Adds to open invoice #${preview.invoiceTarget.invoiceNumber}`
              : 'Starts a new invoice'}
          </p>

          {showPricingToggle && (
            <button
              onClick={() => { const v = !newVehicle; setNewVehicle(v); setPriceOverride(''); void runPreview(fields.stockNumber, v) }}
              className={`mt-3 w-full h-14 rounded-2xl border-2 text-lg font-semibold ${newVehicle ? 'border-green-500 bg-green-500/15 text-green-300' : 'border-gray-700 text-gray-300'}`}
            >
              {newVehicle ? '✓ New Sterling Auto vehicle — $125' : 'New Sterling Auto vehicle? Tap for $125'}
            </button>
          )}

          {!stockValid && fields.stockNumber.length > 0 && !overrideFormat && (
            <button onClick={() => setOverrideFormat(true)} className="mt-3 w-full h-12 rounded-2xl border border-amber-600 text-amber-300 text-sm font-semibold">
              Stock number format looks unusual — tap to use anyway
            </button>
          )}

          {!dealerOk && fields.stockNumber.length > 0 && !resolving && (
            <p className="mt-3 text-amber-400 text-center text-sm">No dealer matches this stock number — check the prefix (K / U / S / T).</p>
          )}

          {preview?.duplicate && (
            <div className="mt-3 rounded-2xl border border-amber-700 bg-amber-950/40 p-4">
              <p className="text-amber-300 font-semibold">Possible duplicate</p>
              <p className="text-amber-200/80 text-sm mt-1">{preview.duplicate.reason}</p>
            </div>
          )}

          {error && <p className="mt-3 text-red-400 text-center text-sm">{error}</p>}

          <div className="mt-auto pt-5 space-y-3">
            {canSend && (
              <button onClick={() => confirm(false)} className="w-full h-16 rounded-2xl bg-green-600 active:bg-green-700 text-white text-xl font-bold">
                Confirm and Send to QuickBooks
              </button>
            )}
            {preview?.duplicate && (
              <button onClick={() => confirm(true)} className="w-full h-14 rounded-2xl border border-amber-600 text-amber-300 text-lg font-semibold">
                Check In Anyway
              </button>
            )}
            <button onClick={reset} className="w-full h-14 rounded-2xl border border-gray-700 text-gray-300 text-lg font-semibold">Retake</button>
          </div>
        </div>
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
              <p className="text-gray-400 max-w-sm">The vehicle is on the Work Board, but QuickBooks was unavailable so the invoice is <span className="text-amber-300 font-semibold">queued</span> and will sync automatically. No invoice exists in QuickBooks yet.</p>
            </>
          ) : (
            <>
              <div className="text-5xl text-green-400">✓</div>
              <p className="text-2xl font-bold">Invoice {writeResult.action === 'appended' ? 'updated' : 'created'}</p>
              <p className="text-gray-300 max-w-sm">
                {writeResult.invoiceNumber
                  ? <>QuickBooks invoice <span className="font-bold text-white">#{writeResult.invoiceNumber}</span> — added to Work Board.</>
                  : <span className="text-amber-300">Written to QuickBooks, but no invoice number was returned — please verify in QuickBooks.</span>}
              </p>
            </>
          )}
          <button onClick={() => router.push(`/work-board?new=${writeResult.serviceOrderId}`)} className="mt-4 w-full max-w-xs h-14 rounded-2xl bg-white text-black text-lg font-bold">
            View Work Board
          </button>
          <button onClick={reset} className="w-full max-w-xs h-12 rounded-2xl border border-gray-700 text-gray-300">Scan another</button>
        </div>
      )}
    </main>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="text-gray-500 text-xs uppercase tracking-widest">{label}</p>
        {hint && <span className="text-gray-600 text-xs">{hint}</span>}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}

function EditRow({
  label, value, onChange, inputMode, autoCapitalize, mono, warn,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  inputMode?: 'numeric' | 'text'
  autoCapitalize?: string
  mono?: boolean
  warn?: boolean
}) {
  return (
    <div className="px-4 py-3">
      <p className="text-gray-500 text-xs uppercase tracking-widest">{label}</p>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={inputMode}
        autoCapitalize={autoCapitalize}
        autoCorrect="off"
        spellCheck={false}
        placeholder="—"
        className={`mt-0.5 w-full bg-transparent outline-none text-lg ${mono ? 'font-mono' : ''} ${warn ? 'text-amber-400' : 'text-white'} placeholder:text-gray-700`}
      />
    </div>
  )
}
