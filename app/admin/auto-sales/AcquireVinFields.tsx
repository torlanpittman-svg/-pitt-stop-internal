'use client'
/** VIN-first acquisition: scan (camera) or type a VIN → decode (reuse /api/vehicle-entry/vin) →
 *  year/make/model auto-fill for the employee to verify. Manual Y/M/M is only the fallback when
 *  decoding fails. Renders controlled inputs with name= so they submit inside the acquisition form. */
import { useRef, useState } from 'react'

const input = 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white'

export default function AcquireVinFields() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [vin, setVin] = useState(''); const [year, setYear] = useState(''); const [make, setMake] = useState(''); const [model, setModel] = useState(''); const [color, setColor] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [extra, setExtra] = useState<string | null>(null)

  async function callDecode(init: RequestInit) {
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/vehicle-entry/vin', init); const j = await res.json()
      if (!res.ok) { setErr(j.error || 'Could not decode VIN — type Y/M/M manually'); }
      else { setVin(j.vin); if (j.year) setYear(j.year); if (j.make) setMake(j.make); if (j.model) setModel(j.model); setExtra([j.bodyClass, j.trim, j.driveType, j.engine].filter(Boolean).join(' · ') || null) }
    } catch { setErr('Decode failed — check connection') }
    setBusy(false)
  }
  const decodeTyped = () => callDecode({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vin }) })
  const onScan = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.set('vinImage', f); callDecode({ method: 'POST', body: fd }) }

  return (
    <div className="rounded-xl border border-indigo-900/40 bg-indigo-950/10 p-3 mb-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-500">VIN <span className="text-gray-600">(scan or type — auto-fills the vehicle)</span><br />
          <input name="vin" value={vin} onChange={(e) => setVin(e.target.value.toUpperCase())} placeholder="17 characters" className={`${input} w-72 font-mono`} /></label>
        <button type="button" onClick={decodeTyped} disabled={busy || vin.length < 17} className="text-sm font-semibold px-3 py-2 rounded-lg border border-gray-700 text-gray-200 disabled:opacity-40">Decode</button>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="text-sm font-semibold px-3 py-2 rounded-lg border border-indigo-700 text-indigo-200">📷 Scan VIN</button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onScan} className="hidden" />
        {busy && <span className="text-gray-500 text-xs mb-2">working…</span>}
      </div>
      {err && <p className="text-amber-400 text-xs mt-1">{err}</p>}
      {extra && <p className="text-gray-500 text-xs mt-1">Decoded: {extra}</p>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
        <label className="text-xs text-gray-500">Year<br /><input name="year" value={year} onChange={(e) => setYear(e.target.value)} className={`${input} w-full`} /></label>
        <label className="text-xs text-gray-500">Make<br /><input name="make" value={make} onChange={(e) => setMake(e.target.value)} className={`${input} w-full`} /></label>
        <label className="text-xs text-gray-500">Model<br /><input name="model" value={model} onChange={(e) => setModel(e.target.value)} className={`${input} w-full`} /></label>
        <label className="text-xs text-gray-500">Color<br /><input name="color" value={color} onChange={(e) => setColor(e.target.value)} className={`${input} w-full`} /></label>
      </div>
    </div>
  )
}
