'use client'
/** Mobile VIN-first vehicle capture: big Scan-VIN button → decode → show decoded Year Make Model as a
 *  confirmation (not redundant manual fields) → Color. Manual Y/M/M is a hidden fallback, revealed only
 *  when decoding fails or the employee taps "Not right?". Hidden inputs carry year/make/model/vin so the
 *  parent acquisition form submits them. Reliable extra attributes (trim/body/engine/drivetrain/fuel)
 *  are saved in the background (server re-decodes on submit). */
import { useRef, useState } from 'react'

const box = 'bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-white w-full'

export default function AcquireVinFields() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [vin, setVin] = useState(''); const [year, setYear] = useState(''); const [make, setMake] = useState(''); const [model, setModel] = useState(''); const [color, setColor] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [extra, setExtra] = useState<string | null>(null)
  const [decoded, setDecoded] = useState(false); const [manual, setManual] = useState(false)

  async function callDecode(init: RequestInit) {
    setBusy(true); setErr(null); setExtra(null)
    try {
      const res = await fetch('/api/vehicle-entry/vin', init); const j = await res.json()
      if (!res.ok) { setErr(j.error || 'Could not read that VIN — enter the vehicle below.'); setManual(true); setDecoded(false) }
      else { setVin(j.vin); setYear(j.year || ''); setMake(j.make || ''); setModel(j.model || ''); setDecoded(Boolean(j.year || j.make || j.model)); setManual(false); setExtra([j.bodyClass, j.trim, j.driveType, j.engine].filter(Boolean).join(' · ') || null) }
    } catch { setErr('Couldn’t reach the VIN service — enter the vehicle below.'); setManual(true) }
    setBusy(false)
  }
  const decodeTyped = () => callDecode({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vin }) })
  const onScan = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.set('vinImage', f); callDecode({ method: 'POST', body: fd }) }

  return (
    <div className="space-y-3">
      {/* Big scan button */}
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
        className="w-full flex items-center justify-center gap-2 bg-indigo-600 active:bg-indigo-700 text-white text-lg font-bold py-4 rounded-2xl disabled:opacity-50">
        📷 Scan VIN
      </button>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onScan} className="hidden" />

      {/* Or type it */}
      <div className="flex gap-2">
        <input name="vin" value={vin} onChange={(e) => { setVin(e.target.value.toUpperCase()); setDecoded(false) }} placeholder="or type VIN" className={`${box} font-mono flex-1`} inputMode="text" autoCapitalize="characters" />
        <button type="button" onClick={decodeTyped} disabled={busy || vin.length < 17} className="px-4 rounded-xl border border-gray-700 text-gray-200 font-semibold disabled:opacity-40">{busy ? '…' : 'Go'}</button>
      </div>
      {err && <p className="text-amber-400 text-sm">{err}</p>}

      {/* Decoded vehicle confirmation (not editable fields) */}
      {decoded && !manual && (
        <div className="rounded-2xl border border-emerald-800/50 bg-emerald-950/20 p-4">
          <p className="text-emerald-300 text-xs uppercase tracking-wide">Vehicle</p>
          <p className="text-white text-xl font-bold mt-0.5">{[year, make, model].filter(Boolean).join(' ')}</p>
          {extra && <p className="text-gray-400 text-xs mt-0.5">{extra}</p>}
          <button type="button" onClick={() => setManual(true)} className="text-gray-500 text-xs underline mt-2">Not right? Enter manually</button>
        </div>
      )}

      {/* Manual fallback (only when decode fails or user opts in) */}
      {manual && (
        <div className="grid grid-cols-3 gap-2">
          <input name="year" value={year} onChange={(e) => setYear(e.target.value)} placeholder="Year" className={box} inputMode="numeric" />
          <input name="make" value={make} onChange={(e) => setMake(e.target.value)} placeholder="Make" className={box} />
          <input name="model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model" className={box} />
        </div>
      )}
      {/* Always submit YMM (hidden when shown as confirmation) */}
      {!manual && <><input type="hidden" name="year" value={year} /><input type="hidden" name="make" value={make} /><input type="hidden" name="model" value={model} /></>}

      {/* Color */}
      <input name="color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="Color" className={box} />
    </div>
  )
}
