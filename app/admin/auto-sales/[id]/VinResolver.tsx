'use client'
/** Add / Scan VIN for a Needs-VIN inventory vehicle. Type the 17-char VIN or scan it with the camera
 *  (reuses the existing /api/vehicle-entry/vin OCR+decode). Shows decoded Y/M/M/trim/body/engine,
 *  flags any conflict with the recorded backfill, and attaches (dedup + PS stock) on confirm. */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { resolveVinAction } from './vin-actions'

type Decoded = { vin: string; year: string | null; make: string | null; model: string | null; bodyClass: string | null; trim?: string | null; driveType?: string | null; engine?: string | null; fuelType?: string | null }

export default function VinResolver({ inventoryVehicleId, backfill }: { inventoryVehicleId: string; backfill: { year: string | null; make: string | null; model: string | null } }) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [vin, setVin] = useState('')
  const [decoded, setDecoded] = useState<Decoded | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ decodedYmm: string; existingYmm: string } | null>(null)
  const [dup, setDup] = useState<string | null>(null)

  async function callDecode(init: RequestInit) {
    setBusy(true); setErr(null); setConflict(null); setDup(null)
    try {
      const res = await fetch('/api/vehicle-entry/vin', init)
      const j = await res.json()
      if (!res.ok) { setErr(j.error || 'Could not decode VIN'); setDecoded(null) }
      else { setDecoded(j); setVin(j.vin) }
    } catch { setErr('Decode failed — check connection') }
    setBusy(false)
  }
  const decodeTyped = () => callDecode({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vin }) })
  const onScan = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.set('vinImage', f); callDecode({ method: 'POST', body: fd }) }

  async function attach(confirmConflict: boolean) {
    setBusy(true); setErr(null)
    const r = await resolveVinAction(inventoryVehicleId, vin, confirmConflict)
    setBusy(false)
    if (r.status === 'ok') { router.refresh() }
    else if (r.status === 'conflict') setConflict({ decodedYmm: [r.decoded?.year, r.decoded?.make, r.decoded?.model].filter(Boolean).join(' '), existingYmm: [r.existingYmm?.year, r.existingYmm?.make, r.existingYmm?.model].filter(Boolean).join(' ') })
    else if (r.status === 'duplicate') setDup(r.duplicateInfo ?? 'This VIN already belongs to another vehicle.')
    else setErr(r.error ?? 'Could not attach VIN')
  }

  const input = 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white'
  return (
    <div className="rounded-2xl border border-indigo-900/50 bg-indigo-950/15 p-5 mt-4">
      <h2 className="text-white font-bold mb-1">Add / Scan VIN <span className="text-gray-500 text-sm font-normal">· resolves identity → PS stock number</span></h2>
      <p className="text-gray-500 text-xs mb-3">Scan the VIN with your camera or type it — we decode year/make/model automatically (no manual entry needed). VIN is the canonical identity.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-500">VIN<br /><input value={vin} onChange={(e) => setVin(e.target.value.toUpperCase())} placeholder="17 characters" className={`${input} w-64 font-mono`} /></label>
        <button onClick={decodeTyped} disabled={busy || vin.length < 17} className="text-sm font-semibold px-3 py-2 rounded-lg border border-gray-700 text-gray-200 disabled:opacity-40">Decode</button>
        <button onClick={() => fileRef.current?.click()} disabled={busy} className="text-sm font-semibold px-3 py-2 rounded-lg border border-indigo-700 text-indigo-200">📷 Scan VIN</button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onScan} className="hidden" />
        {busy && <span className="text-gray-500 text-xs">working…</span>}
      </div>
      {err && <p className="text-red-400 text-xs mt-2">{err}</p>}

      {decoded && (
        <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/60 p-3">
          <p className="text-white text-sm font-semibold">{[decoded.year, decoded.make, decoded.model, decoded.trim].filter(Boolean).join(' ') || 'Decoded'}</p>
          <p className="text-gray-500 text-xs mt-0.5">{[decoded.bodyClass, decoded.driveType, decoded.engine, decoded.fuelType].filter(Boolean).join(' · ') || 'no extra attributes'}</p>
          {backfill.year && [decoded.year, decoded.make, decoded.model].some(Boolean) &&
            (decoded.year !== backfill.year || decoded.make?.toLowerCase() !== (backfill.make ?? '').toLowerCase() || decoded.model?.toLowerCase() !== (backfill.model ?? '').toLowerCase()) &&
            <p className="text-amber-400 text-xs mt-1">⚠ Recorded as {[backfill.year, backfill.make, backfill.model].filter(Boolean).join(' ')} — decode differs. You'll confirm on attach.</p>}
          {!conflict && !dup && <button onClick={() => attach(false)} disabled={busy} className="mt-2 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Attach VIN &amp; generate stock</button>}
        </div>
      )}

      {conflict && (
        <div className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
          <p className="text-amber-300 text-sm font-semibold">VIN/vehicle mismatch — confirm before overwriting</p>
          <p className="text-gray-300 text-xs mt-1">Recorded: <b>{conflict.existingYmm}</b> · VIN decodes to: <b>{conflict.decodedYmm}</b>. If the VIN is correct, we'll update the vehicle to the decoded values.</p>
          <div className="flex gap-2 mt-2">
            <button onClick={() => attach(true)} disabled={busy} className="bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">Confirm — use decoded VIN</button>
            <button onClick={() => setConflict(null)} className="text-gray-400 text-sm px-4 py-2">Cancel</button>
          </div>
        </div>
      )}
      {dup && <div className="mt-3 rounded-lg border border-red-900/50 bg-red-950/20 p-3"><p className="text-red-300 text-sm">{dup}</p></div>}
    </div>
  )
}
