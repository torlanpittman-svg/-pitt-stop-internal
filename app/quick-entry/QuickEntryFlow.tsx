'use client'

/**
 * Quick Entry — capture WHICH services we're doing and put the job on the Work Board.
 * Customer → Vehicle (VIN scan/enter) → tap the services → Review → Create Work Order.
 * No QuickBooks/AutoLeap. NO pricing here: no prices, tiers, size/condition, or totals —
 * tap-to-select only. Pricing/estimating/invoicing is a separate later step (the catalog,
 * price tiers, and price data stay in the DB for that).
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import PhotoInput from '@/app/components/PhotoInput'
import { type JobLine } from '@/apps/quick-entry/job-lines'

type Phase = 'details' | 'services' | 'review' | 'submitting' | 'done'
interface Tier { size: string; condition: string; startPriceCents: number }
interface Pkg { id: string; slug: string; name: string; hasSize: boolean; hasCondition: boolean; defaultPriceCents: number | null; tiers: Tier[] }
interface Tech { slug: string; label: string; group: string }
interface Catalog { packages: Pkg[]; addons: Pkg[]; tech: Tech[]; plateLookupEnabled?: boolean }

const GROUP_LABEL: Record<string, string> = {
  intake_condition_flags: 'Condition flags', pre_work_checks: 'Pre-work checks',
  process_instructions: 'Process', customer_communication: 'Customer comms', free_text: 'Other',
}
// Technician Instructions are hidden from Quick Entry for now. Backend (table, repo,
// work-order techInstructions field) is intact — flip this to true to re-enable the UI.
const SHOW_TECH_INSTRUCTIONS = false
const US_STATE_CODES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']
let keySeq = 0

export default function QuickEntryFlow() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('details')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [cust, setCust] = useState({ name: '', phone: '', email: '' })
  const [veh, setVeh] = useState({ vin: '', year: '', make: '', model: '', color: '' })
  const [vinBusy, setVinBusy] = useState(false)
  const [vinMsg, setVinMsg] = useState<string | null>(null)
  const [vinStatus, setVinStatus] = useState<'idle' | 'reading' | 'ok' | 'error' | 'review'>('idle')

  // Vehicle identification method + plate lookup + audit
  type IdMethod = 'plate_lookup' | 'vin_camera' | 'vin_upload' | 'vin_manual' | 'vehicle_manual'
  const [idMethod, setIdMethod] = useState<IdMethod>('vin_camera')
  const [plate, setPlate] = useState('')
  const [plateState, setPlateState] = useState('TX')
  const [plateBusy, setPlateBusy] = useState(false)
  const [plateMsg, setPlateMsg] = useState<string | null>(null)
  const [plateStatus, setPlateStatus] = useState<'idle' | 'working' | 'ok' | 'error'>('idle')
  const audit = useRef({ rawOcrVin: '' as string, lookupProvider: '' as string, lookupStatus: '' as string, lookupRequestId: '' as string, autoIdentified: false, vehicleEdited: false })
  const markVehicleEdited = () => { if (audit.current.autoIdentified) audit.current.vehicleEdited = true }

  const [lines, setLines] = useState<JobLine[]>([])
  const [tech, setTech] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<{ orderNumber: string; serviceOrderId: string } | null>(null)

  useEffect(() => {
    fetch('/api/quick-entry/catalog').then((r) => r.json()).then((d) => {
      if (d.ok) { setCatalog(d); if (d.plateLookupEnabled) setIdMethod('plate_lookup') }
      else setError(d.error || 'Could not load services')
    }).catch(() => setError('Could not load services'))
  }, [])

  // ── VIN scan (photo or typed) — reuses the estimator VIN decode ────────────
  // Auto-runs the moment a VIN photo is selected (Take or Upload) — no extra tap.
  const decodeVinPhoto = useCallback(async (file: File) => {
    setVinBusy(true); setVinStatus('reading'); setVinMsg('Reading VIN…')
    try {
      const fd = new FormData(); fd.append('vinImage', file, file.name)
      const res = await fetch('/api/estimator/vin', { method: 'POST', body: fd })
      const d = await res.json()
      if (d?.vin) audit.current.rawOcrVin = d.vin  // preserve OCR candidate for audit
      if (res.ok && d.valid && d.vin && (d.make || d.year)) {
        setVeh((v) => ({ ...v, vin: d.vin, year: d.year ?? v.year, make: d.make ?? v.make, model: d.model ?? v.model }))
        audit.current.autoIdentified = true
        setVinStatus('ok'); setVinMsg(`VIN read ✓ ${[d.year, d.make, d.model].filter(Boolean).join(' ')}`.trim())
      } else if (res.ok && d.vin && d.valid === false) {
        // Misread candidate — preserve it in the editable field so it can be corrected.
        setVeh((v) => ({ ...v, vin: d.vin }))
        setVinStatus('review'); setVinMsg(d.message || 'We may have misread one or more characters. Review and correct the VIN.')
      } else if (res.ok && d.vin) {
        setVeh((v) => ({ ...v, vin: d.vin }))  // VIN read but vehicle decode failed — keep Decode/Retry
        setVinStatus('error'); setVinMsg('VIN read but vehicle not decoded — tap Decode to retry.')
      } else {
        setVinStatus('error'); setVinMsg(d.error || 'Could not read the VIN. Take/upload a clearer photo, or type it below.')
      }
    } catch { setVinStatus('error'); setVinMsg('Network error — type the VIN below.') } finally { setVinBusy(false) }
  }, [])
  const decodeVinText = useCallback(async () => {
    const vin = veh.vin.trim().toUpperCase()
    if (vin.length !== 17) { setVinStatus('error'); setVinMsg('VIN must be 17 characters'); return }
    setVinBusy(true); setVinStatus('reading'); setVinMsg('Decoding…')
    try {
      const d = await (await fetch('/api/estimator/vin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin }) })).json()
      if (d.valid && (d.make || d.year)) {
        setVeh((v) => ({ ...v, vin: d.vin ?? v.vin, year: d.year ?? v.year, make: d.make ?? v.make, model: d.model ?? v.model }))
        audit.current.autoIdentified = true
        setVinStatus('ok'); setVinMsg(`Decoded ✓ ${[d.year, d.make, d.model].filter(Boolean).join(' ')}`.trim())
      } else if (d.valid === false && d.vin) {
        setVeh((v) => ({ ...v, vin: d.vin }))  // keep the corrected-but-still-invalid VIN editable
        setVinStatus('review'); setVinMsg(d.message || 'We may have misread one or more characters. Review and correct the VIN.')
      } else {
        setVinStatus('error'); setVinMsg(d.error || 'Could not decode — enter vehicle manually below.')
      }
    } catch { setVinStatus('error'); setVinMsg('Network error') } finally { setVinBusy(false) }
  }, [veh.vin])

  // ── License Plate + State → VIN (only on explicit "Look Up Vehicle" tap) ─────
  const lookupPlate = useCallback(async () => {
    const p = plate.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!p) { setPlateStatus('error'); setPlateMsg('Enter a license plate.'); return }
    setPlateBusy(true); setPlateStatus('working'); setPlateMsg('Looking up vehicle…'); setVinStatus('idle')
    try {
      const res = await fetch('/api/quick-entry/plate-lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plate: p, state: plateState }) })
      const d = await res.json()
      audit.current.lookupProvider = d.provider ?? ''
      audit.current.lookupStatus = d.status ?? (res.ok ? '' : `http_${res.status}`)
      audit.current.lookupRequestId = d.requestId ?? ''
      if (res.ok && d.ok && d.vin) {
        setVeh((v) => ({ ...v, vin: d.vin, year: d.year ?? v.year, make: d.make ?? v.make, model: d.model ?? v.model }))
        audit.current.autoIdentified = true; audit.current.rawOcrVin = ''
        setPlateStatus('ok'); setPlateMsg(`Found ✓ ${[d.year, d.make, d.model].filter(Boolean).join(' ')}`.trim())
        setVinStatus('ok'); setVinMsg(`From plate ${p} · ${plateState}${d.cached ? ' (cached)' : ''}`)
      } else {
        setPlateStatus('error'); setPlateMsg(d.error || 'No vehicle found for that plate. Try a VIN photo or enter the vehicle manually.')
      }
    } catch { setPlateStatus('error'); setPlateMsg('Network error — try a VIN photo or enter the vehicle manually.') } finally { setPlateBusy(false) }
  }, [plate, plateState])

  const snapPlate = useCallback(async (file: File) => {
    setPlateBusy(true); setPlateStatus('working'); setPlateMsg('Reading plate…')
    try {
      const fd = new FormData(); fd.append('plateImage', file, file.name)
      const d = await (await fetch('/api/quick-entry/plate-ocr', { method: 'POST', body: fd })).json()
      if (d.ok && d.plate) { setPlate(d.plate); setPlateStatus('idle'); setPlateMsg(`Read plate: ${d.plate} — check it, pick the state, then Look Up.`) }
      else { setPlateStatus('error'); setPlateMsg(d.error || 'Could not read the plate — type it instead.') }
    } catch { setPlateStatus('error'); setPlateMsg('Network error — type the plate instead.') } finally { setPlateBusy(false) }
  }, [])

  // ── Service selection ───────────────────────────────────────────────────────
  // Pure tap-to-select: no price, no size/condition tiers. Tapping a service toggles it.
  const addLine = (l: Omit<JobLine, 'key'>) => setLines((xs) => [...xs, { ...l, key: `k${keySeq++}` }])
  const isSelected = (id: string) => lines.some((l) => l.catalogId === id)
  const tapPackage = (p: Pkg) => setLines((xs) =>
    xs.some((l) => l.catalogId === p.id)
      ? xs.filter((l) => l.catalogId !== p.id)                                        // deselect
      : [...xs, { key: `k${keySeq++}`, catalogId: p.id, kind: 'package', name: p.name, priceCents: 0 }]) // select
  const addOther = () => addLine({ catalogId: null, kind: 'custom', name: '', priceCents: 0 })
  const setLineName = (key: string, name: string) => setLines((xs) => xs.map((l) => (l.key === key ? { ...l, name } : l)))
  const removeLine = (key: string) => setLines((xs) => xs.filter((l) => l.key !== key))
  const toggleTech = (label: string) => setTech((s) => { const n = new Set(s); n.has(label) ? n.delete(label) : n.add(label); return n })
  // Switch identification method — reset transient status/messages, keep any identified vehicle + audit.
  const chooseMethod = (m: IdMethod) => { setIdMethod(m); setVinStatus('idle'); setVinMsg(null); setPlateStatus('idle'); setPlateMsg(null) }

  // ── Create the job ──────────────────────────────────────────────────────────
  const createJob = useCallback(async () => {
    setPhase('submitting'); setError(null)
    try {
      const res = await fetch('/api/quick-entry/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: cust.name.trim(), customerPhone: cust.phone || null, customerEmail: cust.email || null,
          vehicle: { vin: veh.vin || null, year: veh.year || null, make: veh.make || null, model: veh.model || null, color: veh.color || null },
          lines: lines
            .filter((l) => l.kind !== 'custom' || l.name.trim())  // drop empty "Other" lines
            // Quick Entry ignores pricing: no size/condition, price 0 (set later in estimating/invoicing)
            .map((l) => ({ catalogId: l.catalogId, kind: l.kind, name: l.name.trim(), size: null, condition: null, priceCents: 0 })),
          techInstructions: SHOW_TECH_INSTRUCTIONS ? [...tech] : [], createdBy: 'quick_entry',
          // Vehicle-identification audit (how the vehicle was identified). No secrets.
          audit: {
            idMethod,
            plate: idMethod === 'plate_lookup' ? (plate.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || null) : null,
            plateState: idMethod === 'plate_lookup' ? plateState : null,
            rawOcrVin: audit.current.rawOcrVin || null,
            lookupProvider: audit.current.lookupProvider || null,
            lookupStatus: audit.current.lookupStatus || null,
            lookupRequestId: audit.current.lookupRequestId || null,
            vehicleEdited: audit.current.vehicleEdited,
          },
        }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) throw new Error(d.error || 'Could not create the work order')
      setResult({ orderNumber: d.orderNumber, serviceOrderId: d.serviceOrderId }); setPhase('done')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setPhase('review') }
  }, [cust, veh, lines, tech, idMethod, plate, plateState])

  const input = 'w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col">
      <header className="flex items-center gap-2 px-4 py-3 text-sm shrink-0 border-b border-gray-900">
        <Link href="/" className="text-gray-500">← Pitt Stop</Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-300 font-medium">Quick Entry</span>
        {phase !== 'done' && phase !== 'submitting' && <span className="ml-auto text-gray-600 text-xs">{phase === 'details' ? 'Step 1 · Details' : phase === 'services' ? 'Step 2 · Services' : 'Step 3 · Review'}</span>}
      </header>

      {error && <p className="text-red-400 text-sm text-center px-5 py-2">{error}</p>}

      {/* STEP 1 — customer + vehicle */}
      {phase === 'details' && (
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 pb-28">
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Customer</p>
            <div className="space-y-2">
              <input className={input} placeholder="Customer name *" value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} />
              <input className={input} placeholder="Phone" inputMode="tel" value={cust.phone} onChange={(e) => setCust({ ...cust, phone: e.target.value })} />
              <input className={input} placeholder="Email" inputMode="email" autoCapitalize="off" value={cust.email} onChange={(e) => setCust({ ...cust, email: e.target.value })} />
            </div>
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Vehicle</p>

            {/* Identification method — priority order. License Plate + State is the default when enabled. */}
            <div className="grid grid-cols-1 gap-1.5 mb-3">
              {([
                ['plate_lookup',   'License Plate + State', catalog?.plateLookupEnabled ?? false],
                ['vin_camera',     'Take VIN Photo',        true],
                ['vin_upload',     'Upload VIN Photo',      true],
                ['vin_manual',     'Enter VIN Manually',    true],
                ['vehicle_manual', 'Enter Vehicle Manually',true],
              ] as [IdMethod, string, boolean][]).filter(([, , show]) => show).map(([key, label]) => (
                <button key={key} onClick={() => chooseMethod(key)}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-sm ${idMethod === key ? 'bg-blue-600/20 border-blue-500 text-white font-semibold' : 'bg-gray-900 border-gray-800 text-gray-300'}`}>
                  <span>{label}</span>
                  {key === 'plate_lookup' && <span className="text-[10px] uppercase tracking-wide text-blue-300">Fastest</span>}
                </button>
              ))}
            </div>

            {/* License Plate + State */}
            {idMethod === 'plate_lookup' && (
              <div className="space-y-2 mb-1">
                <div className="flex gap-2">
                  <input className={`${input} font-mono tracking-widest`} placeholder="License plate" autoCapitalize="characters" autoCorrect="off"
                    value={plate} onChange={(e) => { setPlate(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)); setPlateStatus('idle') }} />
                  <select className={`${input} w-24 pr-2`} value={plateState} onChange={(e) => setPlateState(e.target.value)} aria-label="Registration state">
                    {US_STATE_CODES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <button onClick={lookupPlate} disabled={plateBusy || !plate.trim()}
                  className="w-full h-12 rounded-xl bg-blue-600 active:bg-blue-700 text-white font-bold disabled:opacity-40">{plateBusy ? 'Looking up…' : 'Look Up Vehicle'}</button>
                <p className="text-gray-600 text-xs text-center">or snap the plate</p>
                <PhotoInput immediate cameraOnly onCapture={(f) => snapPlate(f)} busy={plateBusy} />
                {plateStatus === 'working' && (
                  <div className="flex items-center gap-2 rounded-xl bg-blue-950/40 border border-blue-800/50 px-3 py-2">
                    <span className="w-4 h-4 border-2 border-blue-300 border-t-transparent rounded-full animate-spin" />
                    <span className="text-blue-200 text-sm">{plateMsg}</span>
                  </div>
                )}
                {plateStatus === 'error' && <div className="rounded-xl bg-red-950/40 border border-red-800/50 px-3 py-2 text-red-300 text-sm">{plateMsg}</div>}
                {plateStatus === 'idle' && plateMsg && <div className="rounded-xl bg-gray-800/60 border border-gray-700 px-3 py-2 text-gray-300 text-sm">{plateMsg}</div>}
              </div>
            )}

            {/* VIN photo — Take (camera) */}
            {idMethod === 'vin_camera' && (
              <div className="mb-1">
                <p className="text-gray-500 text-xs mb-2">Take a VIN photo — it reads automatically.</p>
                <PhotoInput immediate cameraOnly onCapture={(f) => decodeVinPhoto(f)} busy={vinBusy} />
              </div>
            )}
            {/* VIN photo — Upload */}
            {idMethod === 'vin_upload' && (
              <div className="mb-1">
                <p className="text-gray-500 text-xs mb-2">Upload a VIN photo — it reads automatically.</p>
                <PhotoInput immediate uploadOnly uploadLabel="Upload VIN Photo" onCapture={(f) => decodeVinPhoto(f)} busy={vinBusy} />
              </div>
            )}
            {idMethod === 'vin_manual' && <p className="text-gray-500 text-xs mb-2">Type the VIN below, then tap Decode.</p>}
            {idMethod === 'vehicle_manual' && <p className="text-gray-500 text-xs mb-2">Enter the vehicle details below.</p>}

            {/* Shared VIN status (used by VIN decode + plate lookup success) */}
            {vinBusy && (
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-blue-950/40 border border-blue-800/50 px-3 py-2">
                <span className="w-4 h-4 border-2 border-blue-300 border-t-transparent rounded-full animate-spin" />
                <span className="text-blue-200 text-sm">{vinMsg ?? 'Reading VIN…'}</span>
              </div>
            )}
            {!vinBusy && vinStatus === 'ok' && (
              <div className="mt-2 rounded-xl bg-green-950/40 border border-green-800/50 px-3 py-2 text-green-300 text-sm">{vinMsg}</div>
            )}
            {!vinBusy && vinStatus === 'error' && (
              <div className="mt-2 rounded-xl bg-red-950/40 border border-red-800/50 px-3 py-2 text-red-300 text-sm">{vinMsg}</div>
            )}
            {!vinBusy && vinStatus === 'review' && (
              <div className="mt-2 rounded-xl bg-amber-950/40 border border-amber-700/50 px-3 py-2">
                <p className="text-amber-300 text-sm font-medium">{vinMsg}</p>
                <p className="text-amber-400/70 text-xs mt-1">Fix the VIN below and tap Decode, retake/upload the photo, use the license plate, or enter the vehicle manually.</p>
              </div>
            )}

            {/* VIN (editable confirmation) + Decode — for all methods except pure manual vehicle entry */}
            {idMethod !== 'vehicle_manual' && (
              <div className="flex gap-2 mt-2">
                <input className={`${input} font-mono tracking-widest`} placeholder="VIN (17)" autoCapitalize="characters" autoCorrect="off"
                  value={veh.vin} onChange={(e) => { setVeh({ ...veh, vin: e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17) }); setVinStatus('idle'); markVehicleEdited() }} />
                {/* Decode hides once a VIN is successfully decoded/looked up; reappears if the VIN is edited or decode failed */}
                {vinStatus !== 'ok' && (
                  <button onClick={decodeVinText} disabled={vinBusy} className="px-4 rounded-xl bg-gray-800 border border-gray-700 text-sm font-semibold disabled:opacity-50">{vinStatus === 'review' ? 'Decode Again' : 'Decode'}</button>
                )}
              </div>
            )}
            {/* Editable vehicle fields (confirmation). Color not required. */}
            <div className="grid grid-cols-3 gap-2 mt-2">
              <input className={input} placeholder="Year" inputMode="numeric" value={veh.year} onChange={(e) => { setVeh({ ...veh, year: e.target.value }); markVehicleEdited() }} />
              <input className={input} placeholder="Make" value={veh.make} onChange={(e) => { setVeh({ ...veh, make: e.target.value }); markVehicleEdited() }} />
              <input className={input} placeholder="Model" value={veh.model} onChange={(e) => { setVeh({ ...veh, model: e.target.value }); markVehicleEdited() }} />
            </div>
          </div>
          <div className="fixed bottom-0 inset-x-0 p-4 bg-gray-950/95 border-t border-gray-900">
            <button disabled={!cust.name.trim()} onClick={() => setPhase('services')}
              className="w-full h-14 rounded-2xl bg-blue-600 active:bg-blue-700 text-white text-lg font-bold disabled:opacity-40">Next — Services →</button>
          </div>
        </div>
      )}

      {/* STEP 2 — services */}
      {phase === 'services' && (
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 pb-40">
          {!catalog && <p className="text-gray-500 text-sm">Loading services…</p>}
          {catalog && <>
            <div>
              <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Services — tap all that apply</p>
              <div className="grid grid-cols-2 gap-2">
                {catalog.packages.map((p) => (
                  <button key={p.id} onClick={() => tapPackage(p)}
                    className={`relative rounded-2xl border px-3 py-4 text-left ${isSelected(p.id) ? 'bg-blue-600/20 border-blue-500' : 'bg-gray-900 border-gray-800 active:bg-gray-800'}`}>
                    <span className="text-white text-sm font-semibold">{p.name}</span>
                    {isSelected(p.id) && <span className="absolute top-2 right-2 text-blue-400 text-sm">✓</span>}
                  </button>
                ))}
                {/* "Other" — free-text custom service; no price, no catalog mapping */}
                <button onClick={addOther} className="rounded-2xl bg-gray-900 border border-dashed border-gray-700 px-3 py-4 text-left active:bg-gray-800">
                  <span className="text-white text-sm font-semibold">＋ Other</span>
                  <span className="block text-gray-500 text-xs mt-0.5">What are we doing?</span>
                </button>
              </div>
            </div>

            {lines.length > 0 && (
              <div>
                <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Selected</p>
                <div className="rounded-2xl bg-gray-900 border border-gray-800 divide-y divide-gray-800">
                  {lines.map((l) => (
                    <div key={l.key} className="flex items-center gap-2 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        {l.kind === 'custom' ? (
                          // Free-text custom service — supports the keyboard mic (voice dictation)
                          <input value={l.name} onChange={(e) => setLineName(l.key, e.target.value)} placeholder="What are we doing?" autoFocus
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-white text-sm" />
                        ) : (
                          <p className="text-white text-sm truncate">{l.name}</p>
                        )}
                      </div>
                      <button onClick={() => removeLine(l.key)} className="text-gray-600 text-lg px-1">×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {SHOW_TECH_INSTRUCTIONS && (
              <div>
                <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Technician Instructions</p>
                {[...new Set(catalog.tech.map((t) => t.group))].map((g) => (
                  <div key={g} className="mb-2">
                    <p className="text-gray-600 text-[11px] mb-1">{GROUP_LABEL[g] ?? g}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {catalog.tech.filter((t) => t.group === g).map((t) => (
                        <button key={t.slug} onClick={() => toggleTech(t.label)}
                          className={`text-[11px] rounded-full px-2.5 py-1 border ${tech.has(t.label) ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-900 border-gray-700 text-gray-300'}`}>{t.label}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>}

          <div className="fixed bottom-0 inset-x-0 p-4 bg-gray-950/95 border-t border-gray-900 flex items-center gap-3">
            <button onClick={() => setPhase('details')} className="h-14 px-5 rounded-2xl border border-gray-700 text-gray-300 text-sm">Back</button>
            <button onClick={() => setPhase('review')} className="flex-1 h-14 rounded-2xl bg-blue-600 active:bg-blue-700 text-white text-lg font-bold">
              Review →
            </button>
          </div>
        </div>
      )}

      {/* STEP 3 — review */}
      {phase === 'review' && (
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 pb-28">
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
            <p className="text-white font-semibold">{cust.name}</p>
            <p className="text-gray-400 text-sm">{[cust.phone, cust.email].filter(Boolean).join(' · ') || 'no contact'}</p>
            <p className="text-gray-300 text-sm mt-1">{[veh.year, veh.make, veh.model, veh.color].filter(Boolean).join(' ') || veh.vin || 'vehicle TBD'}</p>
            {veh.vin && <p className="text-gray-600 text-xs font-mono">{veh.vin}</p>}
          </div>
          <div className="rounded-2xl bg-gray-900 border border-gray-800 divide-y divide-gray-800">
            <p className="px-4 py-2 text-gray-500 text-xs uppercase tracking-widest">Services</p>
            {lines.length === 0 && <p className="px-4 py-3 text-gray-500 text-sm">No services selected.</p>}
            {lines.map((l) => (
              <div key={l.key} className="px-4 py-2 text-sm">
                <span className="text-gray-200">{l.name.trim() || (l.kind === 'custom' ? 'Custom service' : '')}</span>
              </div>
            ))}
          </div>
          {SHOW_TECH_INSTRUCTIONS && tech.size > 0 && (
            <div className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
              <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Technician instructions</p>
              <div className="flex flex-wrap gap-1.5">{[...tech].map((t) => <span key={t} className="text-[11px] text-gray-300 bg-gray-800 rounded px-2 py-0.5">{t}</span>)}</div>
            </div>
          )}
          <div className="fixed bottom-0 inset-x-0 p-4 bg-gray-950/95 border-t border-gray-900 flex items-center gap-3">
            <button onClick={() => setPhase('services')} className="h-14 px-5 rounded-2xl border border-gray-700 text-gray-300 text-sm">Back</button>
            <button onClick={createJob} className="flex-1 h-14 rounded-2xl bg-green-600 active:bg-green-700 text-white text-lg font-bold">Create Work Order</button>
          </div>
        </div>
      )}

      {phase === 'submitting' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin" />
          <p className="text-lg">Creating work order…</p>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="text-5xl text-green-400">✓</div>
          <p className="text-2xl font-bold">Work order created</p>
          <p className="text-gray-300">Order <span className="font-bold text-white">{result.orderNumber}</span> is on the Work Board.</p>
          <button onClick={() => router.push(`/work-board?new=${result.serviceOrderId}`)} className="mt-3 w-full max-w-xs h-14 rounded-2xl bg-white text-black text-lg font-bold">View Work Board</button>
          <button onClick={() => { setCust({ name: '', phone: '', email: '' }); setVeh({ vin: '', year: '', make: '', model: '', color: '' }); setLines([]); setTech(new Set()); setResult(null); setVinMsg(null); setError(null); setPhase('details') }}
            className="w-full max-w-xs h-12 rounded-2xl border border-gray-700 text-gray-300">New Quick Entry</button>
        </div>
      )}

    </main>
  )
}
