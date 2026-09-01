'use client'

/**
 * Smart Check-In — ONE front door for Work Board "+ Check In". The employee photographs a VIN label OR
 * a dealer tag; Pitt Stop OS classifies the image and routes into the CORRECT existing workflow. No new
 * dealer parser, no duplicate Job/QB logic — it reuses the existing endpoints:
 *   - free client-side VIN barcode (0 AI) → retail
 *   - dealer-tag OCR (/api/dealer-checkin/ocr) + dealer resolution (/api/dealer-checkin/preview) → dealer
 *   - VIN OCR (/api/estimator/vin) → retail
 *   - else → unknown (employee chooses)
 * Dealer → hand off to /dealer-check-in (resumes the exact review + confirm → checkInDealerVehicle).
 * Retail → hand off to /quick-entry (pre-filled identified vehicle; customer + services as today).
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import NavHeader from '@/app/components/NavHeader'
import PhotoInput from '@/app/components/PhotoInput'
import { classifyIntake } from '@/apps/workflow/intake-classify'
import { vinFromBarcode } from './vin-barcode'

type Phase = 'entry' | 'processing' | 'unknown'

export default function SmartCheckIn() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('entry')
  const [status, setStatus] = useState('Reading photo…')
  const [error, setError] = useState<string | null>(null)

  function routeRetail(v: { vin: string; year?: string | null; make?: string | null; model?: string | null }) {
    try { sessionStorage.setItem('ps_intake_retail', JSON.stringify({ vin: v.vin, year: v.year ?? '', make: v.make ?? '', model: v.model ?? '' })) } catch { /* ignore */ }
    router.push('/quick-entry?from=check-in')   // logical parent for Back = Check In
  }
  function routeDealer(ocr: DealerOcr) {
    try {
      sessionStorage.setItem('ps_intake_dealer', JSON.stringify({
        photoUrl: ocr.photoUrl ?? null, imageHash: ocr.imageHash ?? null, rawOcr: ocr.rawOcr ?? null,
        stockNumber: ocr.stockNumber ?? '', year: ocr.year ?? '', make: ocr.make ?? '', model: ocr.model ?? '', color: ocr.color ?? '',
      }))
    } catch { /* ignore */ }
    router.push('/dealer-check-in?from=check-in')   // logical parent for Back = Check In
  }

  async function onPhoto(file: File) {
    setPhase('processing'); setError(null); setStatus('Reading photo…')
    try {
      // 1) FREE barcode pre-pass (no AI). A scannable VIN barcode ⇒ retail (dealer tags are handwritten).
      const barcodeVin = await vinFromBarcode(file)
      if (barcodeVin) {
        setStatus('VIN found — looking it up…')
        const decoded = await decodeVin(barcodeVin)
        return routeRetail(decoded?.valid && decoded.vin
          ? { vin: decoded.vin, year: decoded.year, make: decoded.make, model: decoded.model }
          : { vin: barcodeVin })
      }

      // 2) Dealer-tag OCR + dealer resolution (1 AI call). Dealer evidence is decisive.
      setStatus('Reading the tag…')
      const ocr = await dealerOcr(file)
      let dealerResolved = false
      if (ocr?.stockNumber) {
        const prev = await dealerPreview(ocr.stockNumber)
        dealerResolved = !!prev?.dealership?.qbCustomerId
      }
      const dealer = { stockNumber: ocr?.stockNumber ?? null, dealerResolved }
      if (classifyIntake({ dealer }) === 'dealer' && ocr) return routeDealer(ocr)

      // 3) VIN OCR (2nd AI call) — only when it wasn't a recognized dealer tag.
      setStatus('Checking for a VIN…')
      const vinRes = await vinOcr(file)
      const kind = classifyIntake({ dealer, vin: { vin: vinRes?.vin ?? null, valid: !!vinRes?.valid } })
      if (kind === 'retail' && vinRes?.vin) return routeRetail({ vin: vinRes.vin, year: vinRes.year, make: vinRes.make, model: vinRes.model })

      // 4) Unknown — never guess.
      setPhase('unknown')
    } catch {
      setError('Something went wrong reading the photo. Try again.')
      setPhase('entry')
    }
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col">
      <NavHeader back={{ href: '/work-board', label: 'Work Board' }} title="Check In" />

      {phase === 'entry' && (
        <div className="flex-1 flex flex-col justify-center gap-4 px-6 pb-12">
          <div className="text-center mb-2">
            <h1 className="text-2xl font-bold">+ Check In</h1>
            <p className="text-gray-400 mt-1">Take a photo of the vehicle <span className="text-gray-200">VIN</span> or <span className="text-gray-200">dealer tag</span>.</p>
          </div>
          {error && <p className="text-amber-400 text-center text-sm">{error}</p>}
          <PhotoInput immediate cameraOnly normalize={false} cameraLabel="📷 Take Photo" onCapture={onPhoto} />
          <PhotoInput immediate uploadOnly asLink normalize={false} uploadLabel="Upload Photo" onCapture={onPhoto} />
          <p className="text-gray-600 text-center text-xs mt-2">Pitt Stop figures out what it sees — VIN or dealer tag.</p>
        </div>
      )}

      {phase === 'processing' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <div className="w-10 h-10 border-3 border-white/30 border-t-white rounded-full animate-spin" />
          <p className="text-lg">{status}</p>
        </div>
      )}

      {phase === 'unknown' && (
        <div className="flex-1 flex flex-col justify-center gap-4 px-6 pb-12">
          <div className="text-center mb-2">
            <div className="text-4xl mb-2">🤔</div>
            <h1 className="text-xl font-bold">I couldn’t tell what this photo is.</h1>
            <p className="text-gray-400 mt-1">Pick one to continue.</p>
          </div>
          <button onClick={() => router.push('/quick-entry?from=check-in')} className="w-full h-16 rounded-2xl bg-blue-600 active:bg-blue-700 text-white text-lg font-bold">Scan VIN (retail)</button>
          <button onClick={() => router.push('/dealer-check-in?from=check-in')} className="w-full h-16 rounded-2xl bg-white text-black text-lg font-bold">Scan Dealer Tag</button>
          <button onClick={() => { setError(null); setPhase('entry') }} className="w-full h-14 rounded-2xl border border-gray-700 text-gray-300 text-base">Try Another Photo</button>
        </div>
      )}
    </main>
  )
}

// ── Existing endpoints (reused; the /check-in page is behind the shared employee session) ──
interface DealerOcr { stockNumber?: string | null; year?: string | null; make?: string | null; model?: string | null; color?: string | null; photoUrl?: string | null; imageHash?: string | null; rawOcr?: unknown }

async function dealerOcr(file: File): Promise<DealerOcr | null> {
  const form = new FormData()
  form.append('tagImage', new File([file], 'tag.jpg', { type: file.type || 'image/jpeg' }))
  const res = await fetch('/api/dealer-checkin/ocr', { method: 'POST', body: form })
  if (!res.ok) return null
  const d = await res.json()
  return d?.ok === false ? null : d
}

async function dealerPreview(stockNumber: string): Promise<{ dealership: { qbCustomerId: string | null } | null } | null> {
  const res = await fetch('/api/dealer-checkin/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stockNumber }) })
  if (!res.ok) return null
  return res.json()
}

async function vinOcr(file: File): Promise<{ valid?: boolean; vin?: string; year?: string | null; make?: string | null; model?: string | null } | null> {
  const form = new FormData()
  form.append('vinImage', new File([file], 'vin.jpg', { type: file.type || 'image/jpeg' }))
  const res = await fetch('/api/estimator/vin', { method: 'POST', body: form })
  if (!res.ok) return null // 422 when no VIN visible
  return res.json()
}

async function decodeVin(vin: string): Promise<{ valid?: boolean; vin?: string; year?: string | null; make?: string | null; model?: string | null } | null> {
  const res = await fetch('/api/estimator/vin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin }) })
  if (!res.ok) return null
  return res.json()
}
