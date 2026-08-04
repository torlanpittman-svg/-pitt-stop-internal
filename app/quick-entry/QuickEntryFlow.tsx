'use client'

/**
 * Quick Entry — capture a job fast and put it on the Work Board.
 * Customer → Vehicle (VIN scan/enter) → Services (buttons) → Tech instructions →
 * Review → Create Work Order. No QuickBooks/AutoLeap. Prices editable; "close
 * enough" to start the work.
 */
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import PhotoInput from '@/app/components/PhotoInput'
import { jobTotalCents, fmt, tierLabel, type JobLine } from '@/apps/quick-entry/job-lines'

type Phase = 'details' | 'services' | 'review' | 'submitting' | 'done'
interface Tier { size: string; condition: string; startPriceCents: number }
interface Pkg { id: string; slug: string; name: string; hasSize: boolean; hasCondition: boolean; defaultPriceCents: number | null; tiers: Tier[] }
interface Tech { slug: string; label: string; group: string }
interface Catalog { packages: Pkg[]; addons: Pkg[]; tech: Tech[] }

const GROUP_LABEL: Record<string, string> = {
  intake_condition_flags: 'Condition flags', pre_work_checks: 'Pre-work checks',
  process_instructions: 'Process', customer_communication: 'Customer comms', free_text: 'Other',
}
// Technician Instructions are hidden from Quick Entry for now. Backend (table, repo,
// work-order techInstructions field) is intact — flip this to true to re-enable the UI.
const SHOW_TECH_INSTRUCTIONS = false
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
  const [vinStatus, setVinStatus] = useState<'idle' | 'reading' | 'ok' | 'error'>('idle')

  const [lines, setLines] = useState<JobLine[]>([])
  const [tech, setTech] = useState<Set<string>>(new Set())
  const [picker, setPicker] = useState<Pkg | null>(null)
  const [result, setResult] = useState<{ orderNumber: string; serviceOrderId: string } | null>(null)

  useEffect(() => {
    fetch('/api/quick-entry/catalog').then((r) => r.json()).then((d) => {
      if (d.ok) setCatalog(d); else setError(d.error || 'Could not load services')
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
      if (res.ok && d.vin && (d.make || d.year)) {
        setVeh((v) => ({ ...v, vin: d.vin, year: d.year ?? v.year, make: d.make ?? v.make, model: d.model ?? v.model }))
        setVinStatus('ok'); setVinMsg(`VIN read ✓ ${[d.year, d.make, d.model].filter(Boolean).join(' ')}`.trim())
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
      if (d.vin || d.make) { setVeh((v) => ({ ...v, year: d.year ?? v.year, make: d.make ?? v.make, model: d.model ?? v.model })); setVinStatus('ok'); setVinMsg(`Decoded ✓ ${[d.year, d.make, d.model].filter(Boolean).join(' ')}`.trim()) }
      else { setVinStatus('error'); setVinMsg(d.error || 'Could not decode — enter vehicle manually') }
    } catch { setVinStatus('error'); setVinMsg('Network error') } finally { setVinBusy(false) }
  }, [veh.vin])

  // ── Service selection ───────────────────────────────────────────────────────
  const addLine = (l: Omit<JobLine, 'key'>) => setLines((xs) => [...xs, { ...l, key: `k${keySeq++}` }])
  const tapPackage = (p: Pkg) => {
    if (p.tiers.length > 0) { setPicker(p); return }
    addLine({ catalogId: p.id, kind: 'package', name: p.name, priceCents: p.defaultPriceCents ?? 0 })
  }
  const pickTier = (p: Pkg, t: Tier) => {
    addLine({ catalogId: p.id, kind: 'package', name: p.name, size: t.size, condition: t.condition, priceCents: t.startPriceCents })
    setPicker(null)
  }
  const addOther = () => addLine({ catalogId: null, kind: 'custom', name: '', priceCents: 0 })
  const setPrice = (key: string, dollars: string) => {
    const cents = Math.round(parseFloat(dollars || '0') * 100)
    setLines((xs) => xs.map((l) => (l.key === key ? { ...l, priceCents: Number.isFinite(cents) ? cents : 0 } : l)))
  }
  const setLineName = (key: string, name: string) => setLines((xs) => xs.map((l) => (l.key === key ? { ...l, name } : l)))
  const removeLine = (key: string) => setLines((xs) => xs.filter((l) => l.key !== key))
  const toggleTech = (label: string) => setTech((s) => { const n = new Set(s); n.has(label) ? n.delete(label) : n.add(label); return n })

  const total = jobTotalCents(lines)

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
            .map((l) => ({ catalogId: l.catalogId, kind: l.kind, name: l.name.trim(), size: l.size ?? null, condition: l.condition ?? null, priceCents: l.priceCents })),
          techInstructions: SHOW_TECH_INSTRUCTIONS ? [...tech] : [], createdBy: 'quick_entry',
        }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) throw new Error(d.error || 'Could not create the work order')
      setResult({ orderNumber: d.orderNumber, serviceOrderId: d.serviceOrderId }); setPhase('done')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setPhase('review') }
  }, [cust, veh, lines, tech])

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
            <p className="text-gray-500 text-xs mb-2">Take or upload a VIN photo — it reads automatically. Or type the VIN / enter the vehicle below.</p>
            {/* immediate: OCR runs the moment a photo is chosen — no separate "Scan VIN" tap */}
            <PhotoInput immediate onCapture={(f) => decodeVinPhoto(f)} busy={vinBusy} />

            {/* prominent VIN status */}
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

            <div className="flex gap-2 mt-2">
              <input className={`${input} font-mono tracking-widest`} placeholder="VIN (17)" autoCapitalize="characters" autoCorrect="off"
                value={veh.vin} onChange={(e) => { setVeh({ ...veh, vin: e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17) }); setVinStatus('idle') }} />
              {/* Decode hides once a VIN is successfully decoded; reappears if the VIN is edited or decode failed */}
              {vinStatus !== 'ok' && (
                <button onClick={decodeVinText} disabled={vinBusy} className="px-4 rounded-xl bg-gray-800 border border-gray-700 text-sm font-semibold disabled:opacity-50">Decode</button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2">
              <input className={input} placeholder="Year" inputMode="numeric" value={veh.year} onChange={(e) => setVeh({ ...veh, year: e.target.value })} />
              <input className={input} placeholder="Make" value={veh.make} onChange={(e) => setVeh({ ...veh, make: e.target.value })} />
              <input className={input} placeholder="Model" value={veh.model} onChange={(e) => setVeh({ ...veh, model: e.target.value })} />
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
              <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Packages</p>
              <div className="grid grid-cols-2 gap-2">
                {catalog.packages.map((p) => (
                  <button key={p.id} onClick={() => tapPackage(p)} className="rounded-2xl bg-gray-900 border border-gray-800 px-3 py-3 text-left active:bg-gray-800">
                    <span className="text-white text-sm font-semibold">{p.name}</span>
                    <span className="block text-gray-500 text-xs mt-0.5">{p.tiers.length ? `from ${fmt(Math.min(...p.tiers.map((t) => t.startPriceCents)))}` : fmt(p.defaultPriceCents ?? 0)}</span>
                  </button>
                ))}
                {/* "Other" — free-text custom service; no default price, no catalog mapping */}
                <button onClick={addOther} className="rounded-2xl bg-gray-900 border border-dashed border-gray-700 px-3 py-3 text-left active:bg-gray-800">
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
                        {(l.size || l.condition) && <p className="text-gray-500 text-xs">{tierLabel(l.size, l.condition)}</p>}
                      </div>
                      <span className="text-gray-500 text-sm">$</span>
                      <input inputMode="decimal" value={(l.priceCents / 100).toString()} onChange={(e) => setPrice(l.key, e.target.value)}
                        className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-white text-sm text-right" />
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
              Review · {fmt(total)} →
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
            {lines.length === 0 && <p className="px-4 py-3 text-gray-500 text-sm">No services selected.</p>}
            {lines.map((l) => (
              <div key={l.key} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="text-gray-300">{(l.name.trim() || (l.kind === 'custom' ? 'Custom service' : ''))}{(l.size || l.condition) ? ` (${tierLabel(l.size, l.condition)})` : ''}</span>
                <span className="text-white">{fmt(l.priceCents)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-gray-400 font-semibold">Total (editable later)</span>
              <span className="text-white font-bold">{fmt(total)}</span>
            </div>
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

      {/* package size/condition picker */}
      {picker && (
        <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-20 p-4" onClick={() => setPicker(null)}>
          <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-3xl p-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-white font-semibold mb-3">{picker.name} — pick size{picker.hasCondition ? ' & condition' : ''}</p>
            <div className="space-y-2">
              {picker.tiers.map((t, i) => (
                <button key={i} onClick={() => pickTier(picker, t)} className="w-full flex items-center justify-between rounded-2xl bg-gray-800 border border-gray-700 px-4 py-3 active:bg-gray-700">
                  <span className="text-white text-sm">{tierLabel(t.size, t.condition)}</span>
                  <span className="text-white font-bold">{fmt(t.startPriceCents)}</span>
                </button>
              ))}
            </div>
            <button onClick={() => setPicker(null)} className="w-full mt-3 h-11 rounded-2xl border border-gray-700 text-gray-400">Cancel</button>
          </div>
        </div>
      )}
    </main>
  )
}
