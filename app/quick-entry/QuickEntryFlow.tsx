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
import PhotoInput from '@/app/components/PhotoInput'
import NavHeader from '@/app/components/NavHeader'
import { useIdentity } from '@/app/components/IdentityBar'
import { type JobLine } from '@/apps/quick-entry/job-lines'
import { type CustomerMatch, type CustVehicle } from '@/apps/quick-entry/customers'

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
let keySeq = 0

// P-B1 manager-only pricing card: the shop's fee/tax rules that will apply to this
// Job's commercial layer. Informational/read-only — no price input, no new taps.
type BizConfig = { shopSuppliesEnabled: boolean; shopSuppliesBps: number; shopSuppliesCapCents: number; cardFeeEnabled: boolean; cardFeeBps: number; defaultTaxBps: number }
const pct = (bps: number) => `${(bps / 100).toString()}%`
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`
const dollarsToCents = (s: string) => { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0 }

export default function QuickEntryFlow() {
  const router = useRouter()
  const identity = useIdentity()
  const isManager = identity.effectiveRole === 'manager' || identity.effectiveRole === 'admin'
  const [bizCfg, setBizCfg] = useState<BizConfig | null>(null)
  const [workPrice, setWorkPrice] = useState('')                 // dollars string, manager-only
  const [pricePreview, setPricePreview] = useState<null | { workPriceCents: number; shopSuppliesCents: number; cardFeeCents: number; cardFeeEnabled: boolean; taxCents: number; needsTaxReview: boolean; totalCents: number }>(null)
  const [phase, setPhase] = useState<Phase>('details')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Load the fee/tax rules once, only for a manager/admin (endpoint is role-gated).
  useEffect(() => {
    if (!isManager || bizCfg) return
    fetch('/api/settings/business').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d && !d.error) setBizCfg(d) }).catch(() => {})
  }, [isManager, bizCfg])

  // Live explicit-price preview (manager only, debounced) — uses the real engine.
  useEffect(() => {
    if (!isManager) { setPricePreview(null); return }
    const cents = dollarsToCents(workPrice)
    if (!cents) { setPricePreview(null); return }
    const t = setTimeout(() => {
      fetch('/api/quick-entry/pricing-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workPriceCents: cents }) })
        .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d && !d.error) setPricePreview(d) }).catch(() => {})
    }, 350)
    return () => clearTimeout(t)
  }, [workPrice, isManager])

  const [cust, setCust] = useState({ first: '', last: '', phone: '', email: '' })
  const [veh, setVeh] = useState({ vin: '', year: '', make: '', model: '', color: '' })
  const [vinBusy, setVinBusy] = useState(false)
  const [vinMsg, setVinMsg] = useState<string | null>(null)
  const [vinStatus, setVinStatus] = useState<'idle' | 'reading' | 'ok' | 'error' | 'review'>('idle')
  const [vinPhotoUrl, setVinPhotoUrl] = useState<string | null>(null)  // original VIN photo preview

  // Returning-customer autofill
  const [matches, setMatches] = useState<CustomerMatch[]>([])
  const [custVehicles, setCustVehicles] = useState<CustVehicle[]>([])
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null)
  const [vehicleMode, setVehicleMode] = useState<'new' | 'existing' | 'pick'>('new')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Identification is VIN-photo only (camera or upload). Plate lookup / manual entry are
  // removed from the employee UI (provider code + DB kept, feature-flag disabled).
  type IdMethod = 'vin_camera' | 'vin_upload' | 'returning_vehicle'
  const idMethodRef = useRef<IdMethod>('vin_camera')
  const audit = useRef({ rawOcrVin: '' as string, autoIdentified: false, vehicleEdited: false })
  const markVehicleEdited = () => { if (audit.current.autoIdentified) audit.current.vehicleEdited = true }
  const decodeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [lines, setLines] = useState<JobLine[]>([])
  const [tech, setTech] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<{ orderNumber: string; serviceOrderId: string } | null>(null)

  useEffect(() => {
    fetch('/api/quick-entry/catalog').then((r) => r.json()).then((d) => {
      if (d.ok) setCatalog(d); else setError(d.error || 'Could not load services')
    }).catch(() => setError('Could not load services'))
  }, [])
  // Clean up the object URL + any pending debounce on unmount.
  useEffect(() => () => { if (vinPhotoUrl) URL.revokeObjectURL(vinPhotoUrl); if (decodeTimer.current) clearTimeout(decodeTimer.current) }, [vinPhotoUrl])

  // ── VIN photo → OCR → editable candidate → auto validate/decode ─────────────
  // Runs automatically the moment a photo is selected (Take or Upload) — no extra tap.
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
      } else if (res.ok && d.vin) {
        // Candidate read but not valid/decoded — keep it editable to correct.
        setVeh((v) => ({ ...v, vin: d.vin }))
        setVinStatus('review'); setVinMsg('Review the VIN. We may have misread one or more characters.')
      } else {
        setVinStatus('error'); setVinMsg('Could not read the VIN from the photo. Retake or upload a clearer photo.')
      }
    } catch { setVinStatus('error'); setVinMsg('Network error reading the photo — retake or upload again.') } finally { setVinBusy(false) }
  }, [])

  // Show the original photo, then run OCR. Both Take and Upload funnel through here.
  const onVinPhoto = useCallback((file: File, method: IdMethod) => {
    idMethodRef.current = method
    setVinPhotoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file) })
    void decodeVinPhoto(file)
  }, [decodeVinPhoto])

  // Validate + decode a typed/edited VIN. Fills Year/Make/Model when valid; keeps the
  // candidate editable when not. Used by the debounced auto-decode on edit.
  const decodeVinValue = useCallback(async (raw: string) => {
    const vin = raw.trim().toUpperCase()
    if (vin.length !== 17) return
    setVinBusy(true); setVinStatus('reading'); setVinMsg('Checking VIN…')
    try {
      const d = await (await fetch('/api/estimator/vin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin }) })).json()
      if (d.valid && (d.make || d.year)) {
        setVeh((v) => ({ ...v, vin: d.vin ?? v.vin, year: d.year ?? v.year, make: d.make ?? v.make, model: d.model ?? v.model }))
        audit.current.autoIdentified = true
        setVinStatus('ok'); setVinMsg(`VIN ✓ ${[d.year, d.make, d.model].filter(Boolean).join(' ')}`.trim())
      } else {
        setVinStatus('review'); setVinMsg('Review the VIN. We may have misread one or more characters.')
      }
    } catch { setVinStatus('error'); setVinMsg('Network error — check the VIN and try again.') } finally { setVinBusy(false) }
  }, [])

  // Debounced auto-decode as the employee corrects the VIN (no Decode button to tap).
  const onVinEdit = useCallback((raw: string) => {
    const vin = raw.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17)  // strip I/O/Q, spaces, punctuation
    setVeh((v) => ({ ...v, vin })); markVehicleEdited()
    if (decodeTimer.current) clearTimeout(decodeTimer.current)
    if (vin.length === 17) { decodeTimer.current = setTimeout(() => void decodeVinValue(vin), 550) }
    else { setVinStatus('idle'); setVinMsg(null) }
  }, [decodeVinValue])

  // ── Returning-customer search + selection ──────────────────────────────────
  const searchCustomers = useCallback((q: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (q.trim().length < 2) { setMatches([]); return }
    searchTimer.current = setTimeout(async () => {
      try { const d = await (await fetch(`/api/quick-entry/customers?q=${encodeURIComponent(q.trim())}`)).json(); setMatches(d.customers ?? []) }
      catch { /* ignore */ }
    }, 300)
  }, [])
  const selectVehicle = useCallback((vh: CustVehicle) => {
    setVeh({ vin: vh.vin ?? '', year: vh.year ?? '', make: vh.make ?? '', model: vh.model ?? '', color: '' })
    setSelectedVehicleId(vh.id); setVehicleMode('existing')
    setVinPhotoUrl((u) => { if (u) URL.revokeObjectURL(u); return null })
    idMethodRef.current = 'returning_vehicle'; audit.current.autoIdentified = true
    setVinStatus('ok'); setVinMsg(`Saved vehicle ✓ ${vh.label}`)
  }, [])
  const addNewVehicle = useCallback(() => {
    setSelectedVehicleId(null); setVeh({ vin: '', year: '', make: '', model: '', color: '' })
    setVehicleMode('new'); setVinStatus('idle'); setVinMsg(null)
    setVinPhotoUrl((u) => { if (u) URL.revokeObjectURL(u); return null })
    idMethodRef.current = 'vin_camera'
  }, [])
  const selectCustomer = useCallback((m: CustomerMatch) => {
    setCust({ first: m.first, last: m.last, phone: m.phone ?? '', email: m.email ?? '' })
    setCustVehicles(m.vehicles); setMatches([])
    if (m.vehicles.length === 1) selectVehicle(m.vehicles[0])
    else if (m.vehicles.length > 1) { setVehicleMode('pick'); setSelectedVehicleId(null) }
    else addNewVehicle()
  }, [selectVehicle, addNewVehicle])

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

  // ── Create the job ──────────────────────────────────────────────────────────
  const createJob = useCallback(async () => {
    setPhase('submitting'); setError(null)
    try {
      const res = await fetch('/api/quick-entry/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: `${cust.first} ${cust.last}`.trim(), customerPhone: cust.phone || null, customerEmail: cust.email || null,
          vehicle: { vin: veh.vin || null, year: veh.year || null, make: veh.make || null, model: veh.model || null, color: veh.color || null },
          vehicleId: vehicleMode === 'existing' ? selectedVehicleId : null,  // reuse the exact saved vehicle (no duplicate)
          lines: lines
            .filter((l) => l.kind !== 'custom' || l.name.trim())  // drop empty "Other" lines
            // Quick Entry ignores pricing: no size/condition, price 0 (set later in estimating/invoicing)
            .map((l) => ({ catalogId: l.catalogId, kind: l.kind, name: l.name.trim(), size: null, condition: null, priceCents: 0 })),
          techInstructions: SHOW_TECH_INSTRUCTIONS ? [...tech] : [], createdBy: 'quick_entry',
          // Manager-entered work price (server drops it for non-managers → itemized/$0).
          workPriceCents: dollarsToCents(workPrice) || null,
          // Vehicle-identification audit (VIN photo only now). No secrets.
          audit: {
            idMethod: idMethodRef.current,
            plate: null, plateState: null,
            rawOcrVin: audit.current.rawOcrVin || null,
            lookupProvider: null, lookupStatus: null, lookupRequestId: null,
            vehicleEdited: audit.current.vehicleEdited,
          },
        }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) throw new Error(d.error || 'Could not create the Job')
      setResult({ orderNumber: d.orderNumber, serviceOrderId: d.serviceOrderId }); setPhase('done')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setPhase('review') }
  }, [cust, veh, lines, tech, vehicleMode, selectedVehicleId])

  const input = 'w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col">
      <NavHeader title={`Quick Entry${phase === 'details' ? ' · Details' : phase === 'services' ? ' · Services' : phase === 'review' ? ' · Review' : ''}`} />

      {error && <p className="text-red-400 text-sm text-center px-5 py-2">{error}</p>}

      {/* STEP 1 — customer + vehicle */}
      {phase === 'details' && (
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 pb-28">
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Customer</p>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input className={input} placeholder="First name *" value={cust.first} onChange={(e) => { setCust({ ...cust, first: e.target.value }); searchCustomers(e.target.value) }} />
                <input className={input} placeholder="Last name" value={cust.last} onChange={(e) => { setCust({ ...cust, last: e.target.value }); searchCustomers(`${cust.first} ${e.target.value}`.trim()) }} />
              </div>
              <input className={input} placeholder="Phone number" inputMode="tel" value={cust.phone} onChange={(e) => { setCust({ ...cust, phone: e.target.value }); searchCustomers(e.target.value) }} />
              <input className={input} placeholder="Email" inputMode="email" autoCapitalize="off" value={cust.email} onChange={(e) => { setCust({ ...cust, email: e.target.value }); searchCustomers(e.target.value) }} />
            </div>

            {/* Returning-customer matches */}
            {matches.length > 0 && (
              <div className="mt-2 rounded-2xl bg-gray-900 border border-gray-800 divide-y divide-gray-800 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5">
                  <span className="text-gray-500 text-[11px] uppercase tracking-widest">Returning customers</span>
                  <button onClick={() => setMatches([])} className="text-gray-600 text-xs">Dismiss</button>
                </div>
                {matches.map((m, i) => (
                  <button key={i} onClick={() => selectCustomer(m)} className="w-full text-left px-3 py-2.5 active:bg-gray-800">
                    <p className="text-white text-sm font-semibold">{m.name || `${m.first} ${m.last}`.trim()}</p>
                    <p className="text-gray-500 text-xs">{[m.phone, m.email].filter(Boolean).join(' · ') || 'no contact'}</p>
                    {m.vehicles.length > 0 && <p className="text-gray-400 text-xs mt-0.5 truncate">{m.vehicles.map((v) => v.label).join(' · ')}</p>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Vehicle</p>

            {/* Returning customer with multiple vehicles → pick one or add new */}
            {vehicleMode === 'pick' && (
              <div className="space-y-2">
                <p className="text-gray-500 text-xs">Which vehicle is this?</p>
                {custVehicles.map((vh) => (
                  <button key={vh.id} onClick={() => selectVehicle(vh)} className="w-full text-left rounded-xl bg-gray-900 border border-gray-800 px-3 py-3 active:bg-gray-800">
                    <p className="text-white text-sm font-semibold">{vh.label}</p>
                    {vh.vin && <p className="text-gray-600 text-xs font-mono">{vh.vin}</p>}
                  </button>
                ))}
                <button onClick={addNewVehicle} className="w-full rounded-xl border border-dashed border-gray-700 px-3 py-3 text-blue-400 text-sm active:bg-gray-800">＋ Add a new vehicle</button>
              </div>
            )}

            {/* Existing saved vehicle → no VIN photo needed */}
            {vehicleMode === 'existing' && (
              <div className="space-y-2">
                <div className="rounded-2xl bg-green-950/30 border border-green-800/40 px-4 py-3">
                  <p className="text-green-300 text-[11px] uppercase tracking-widest">Saved vehicle</p>
                  <p className="text-white font-semibold mt-0.5">{[veh.year, veh.make, veh.model].filter(Boolean).join(' ') || 'Vehicle'}</p>
                  {veh.vin && <p className="text-gray-500 text-xs font-mono mt-0.5">{veh.vin}</p>}
                </div>
                <div className="flex gap-4 text-sm">
                  {custVehicles.length > 1 && <button onClick={() => setVehicleMode('pick')} className="text-gray-400 underline">Use a different vehicle</button>}
                  <button onClick={addNewVehicle} className="text-blue-400 underline">Add new vehicle</button>
                </div>
              </div>
            )}

            {/* New vehicle → normal Take/Upload VIN photo flow */}
            {vehicleMode === 'new' && (
              <>
                <p className="text-gray-500 text-xs mb-2">VIN Photo</p>
                <PhotoInput immediate cameraOnly cameraLabel="📷 Take Photo of VIN" onCapture={(f) => onVinPhoto(f, 'vin_camera')} busy={vinBusy} />
                <div className="mt-2">
                  <PhotoInput immediate uploadOnly asLink uploadLabel="Upload a photo instead" onCapture={(f) => onVinPhoto(f, 'vin_upload')} busy={vinBusy} />
                </div>
                {vinPhotoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={vinPhotoUrl} alt="VIN photo" className="mt-3 w-full max-h-56 object-contain rounded-2xl bg-gray-900 border border-gray-800" />
                )}
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
                    <p className="text-amber-300 text-sm font-medium">Review the VIN. We may have misread one or more characters.</p>
                    <p className="text-amber-400/70 text-xs mt-1">Fix only the wrong character(s) below — it rechecks automatically. Or retake / upload a clearer photo.</p>
                  </div>
                )}
                <input className={`${input} font-mono tracking-widest mt-2`} placeholder="VIN (17)" autoCapitalize="characters" autoCorrect="off"
                  value={veh.vin} onChange={(e) => onVinEdit(e.target.value)} />
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <input className={input} placeholder="Year" inputMode="numeric" value={veh.year} onChange={(e) => { setVeh({ ...veh, year: e.target.value }); markVehicleEdited() }} />
                  <input className={input} placeholder="Make" value={veh.make} onChange={(e) => { setVeh({ ...veh, make: e.target.value }); markVehicleEdited() }} />
                  <input className={input} placeholder="Model" value={veh.model} onChange={(e) => { setVeh({ ...veh, model: e.target.value }); markVehicleEdited() }} />
                </div>
              </>
            )}
          </div>
          <div className="fixed bottom-0 inset-x-0 p-4 bg-gray-950/95 border-t border-gray-900">
            <button disabled={!cust.first.trim()} onClick={() => setPhase('services')}
              className="w-full h-14 rounded-2xl bg-blue-600 active:bg-blue-700 text-white text-lg font-bold disabled:opacity-40">Continue →</button>
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
            <p className="text-white font-semibold">{`${cust.first} ${cust.last}`.trim() || 'Customer'}</p>
            <p className="text-gray-400 text-sm">{[cust.phone, cust.email].filter(Boolean).join(' · ') || 'no contact'}</p>
            <p className="text-gray-300 text-sm mt-1">{[veh.year, veh.make, veh.model].filter(Boolean).join(' ') || veh.vin || 'vehicle TBD'}</p>
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

          {/* P-B2: manager/admin-only pricing. Optional Work Price → live engine preview.
              Employees never see this. Leaving it blank keeps the itemized/$0 path. */}
          {isManager && bizCfg && (
            <div className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
              <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Pricing · manager view</p>
              <label className="block">
                <span className="text-gray-400 text-sm">Work price <span className="text-gray-600">(optional)</span></span>
                <div className="mt-1 flex items-center rounded-xl bg-gray-800 border border-gray-700 px-3">
                  <span className="text-gray-500">$</span>
                  <input value={workPrice} onChange={(e) => setWorkPrice(e.target.value)} inputMode="decimal" placeholder="0.00"
                    className="flex-1 bg-transparent px-2 py-3 text-white text-base focus:outline-none" />
                </div>
              </label>
              {pricePreview ? (
                <div className="mt-3 space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-gray-400">Work price</span><span className="text-gray-200">{usd(pricePreview.workPriceCents)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Shop supplies{bizCfg.shopSuppliesEnabled ? ` (${pct(bizCfg.shopSuppliesBps)}, max ${usd(bizCfg.shopSuppliesCapCents)})` : ''}</span><span className="text-gray-200">{usd(pricePreview.shopSuppliesCents)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Tax</span><span className={pricePreview.needsTaxReview ? 'text-amber-400' : 'text-gray-200'}>{pricePreview.needsTaxReview ? 'review — pending CPA' : usd(pricePreview.taxCents)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Card processing</span><span className="text-gray-200">{pricePreview.cardFeeEnabled ? usd(pricePreview.cardFeeCents) : 'Off'}</span></div>
                  <div className="border-t border-gray-800 my-1.5" />
                  <div className="flex justify-between"><span className="text-white font-semibold">Estimated total</span><span className="text-white font-semibold">{usd(pricePreview.totalCents)}</span></div>
                </div>
              ) : (
                <p className="text-gray-600 text-xs mt-2.5">Shop supplies {pct(bizCfg.shopSuppliesBps)} (max {usd(bizCfg.shopSuppliesCapCents)}) · tax {pct(bizCfg.defaultTaxBps)} · card {bizCfg.cardFeeEnabled ? pct(bizCfg.cardFeeBps) : 'off'}. Enter a work price to preview the total, or leave blank.</p>
              )}
            </div>
          )}
          <div className="fixed bottom-0 inset-x-0 p-4 bg-gray-950/95 border-t border-gray-900 flex items-center gap-3">
            <button onClick={() => setPhase('services')} className="h-14 px-5 rounded-2xl border border-gray-700 text-gray-300 text-sm">Back</button>
            <button onClick={createJob} className="flex-1 h-14 rounded-2xl bg-green-600 active:bg-green-700 text-white text-lg font-bold">Create Job</button>
          </div>
        </div>
      )}

      {phase === 'submitting' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin" />
          <p className="text-lg">Creating the Job…</p>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="text-5xl text-green-400">✓</div>
          <p className="text-2xl font-bold">Job created</p>
          <p className="text-gray-300">The Job is on the Work Board.</p>
          <button onClick={() => router.push(`/work-board?new=${result.serviceOrderId}`)} className="mt-3 w-full max-w-xs h-14 rounded-2xl bg-white text-black text-lg font-bold">View Work Board</button>
          <button onClick={() => { setCust({ first: '', last: '', phone: '', email: '' }); setVeh({ vin: '', year: '', make: '', model: '', color: '' }); setLines([]); setTech(new Set()); setResult(null); setVinMsg(null); setVinStatus('idle'); setVinPhotoUrl((u) => { if (u) URL.revokeObjectURL(u); return null }); setMatches([]); setCustVehicles([]); setSelectedVehicleId(null); setVehicleMode('new'); setError(null); setPhase('details') }}
            className="w-full max-w-xs h-12 rounded-2xl border border-gray-700 text-gray-300">New Quick Entry</button>
        </div>
      )}

    </main>
  )
}
