/**
 * Auto-Sales — Owned inventory (mobile-first, phone-primary). Employee view: what cars do we own and
 * what do I need to do with them. Cards, not a dense financial table. Quick Acquisition is VIN-first
 * with optional details hidden. Admin-gated; ships dark behind auto_sales_enabled. Underlying ledger/
 * VIN-dedup/floor-plan architecture is unchanged — this is a UX simplification only.
 */
import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { autoSalesEnabled } from '@/apps/settings/db'
import { getInventoryList, createAcquisition } from '@/apps/auto-sales/db'
import { validateVIN, normalizeVIN, decodeVINFromNHTSA } from '@/apps/vehicle-entry/vin'
import { IN_SCOPE_ACCOUNTS } from '@/apps/auto-sales/types'
import AcquireVinFields from './AcquireVinFields'

export const dynamic = 'force-dynamic'
const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const STATUS: Record<string, { c: string; label: string }> = {
  acquired: { c: 'bg-gray-800 text-gray-300 border-gray-700', label: 'In inventory' },
  in_recon: { c: 'bg-blue-950/40 text-blue-300 border-blue-900/60', label: 'In recon' },
  listed: { c: 'bg-blue-950/40 text-blue-300 border-blue-900/60', label: 'Listed' },
  sale_pending: { c: 'bg-blue-950/40 text-blue-300 border-blue-900/60', label: 'Sale pending' },
  sold: { c: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60', label: 'Sold' },
  delivered: { c: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60', label: 'Delivered' },
}

async function acquireAction(fd: FormData) {
  'use server'
  const rawVin = String(fd.get('vin') ?? '').trim()
  const cost = Math.round(parseFloat(String(fd.get('cost') ?? '')) * 100)
  const acquiredAt = String(fd.get('acquiredAt') ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquiredAt) || !Number.isFinite(cost) || cost < 0) { revalidatePath('/admin/auto-sales'); return }
  // Reuse the existing VIN validator + NHTSA decoder (authoritative on submit; extra attrs saved).
  let year = String(fd.get('year') ?? '') || null, make = String(fd.get('make') ?? '') || null, model = String(fd.get('model') ?? '') || null
  let vin: string | null = null, vinRaw: unknown = null
  if (rawVin) {
    const { valid } = validateVIN(rawVin)
    if (valid) {
      vin = normalizeVIN(rawVin)
      try { const d = await decodeVINFromNHTSA(vin); year = d.year || year; make = d.make || make; model = d.model || model; vinRaw = d } catch { /* NHTSA down — keep provided values */ }
    }
  }
  await createAcquisition({
    vin, year, make, model, color: String(fd.get('color') ?? '') || null, vinRaw,
    acquisitionCostCents: cost, acquiredAt, acquisitionSource: String(fd.get('source') ?? '') || undefined,
    seller: String(fd.get('seller') ?? '') || undefined, paymentAccountRef: String(fd.get('account') ?? 'unknown'),
    floorPlanned: fd.get('floorPlanned') === 'on', floorPlanLender: String(fd.get('floorPlanLender') ?? '') || undefined,
    origin: 'quick_entry', actor: 'admin',
  })
  revalidatePath('/admin/auto-sales')
}

const box = 'bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-white w-full'

export default async function AutoSalesPage() {
  const [enabled, list] = await Promise.all([autoSalesEnabled(), getInventoryList()])
  const today = new Date().toISOString().slice(0, 10)
  const active = list.filter((r) => !['sold', 'delivered', 'wholesaled'].includes(r.status))

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-white">Auto Sales</h1>
        <Link href="/admin" className="text-gray-500 text-sm">Admin</Link>
      </div>
      {!enabled && <p className="text-amber-400 text-xs mb-3">Preview — auto_sales_enabled is OFF.</p>}

      {/* Add a vehicle (VIN-first; details hidden) */}
      <details className="rounded-2xl bg-gray-900 border border-gray-800 mb-5 overflow-hidden">
        <summary className="flex items-center justify-between px-4 py-4 cursor-pointer list-none">
          <span className="text-white font-bold text-lg">+ Add a vehicle</span>
          <span className="text-gray-500 text-sm">scan a VIN ▾</span>
        </summary>
        <form action={acquireAction} className="px-4 pb-4 space-y-3">
          <AcquireVinFields />
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-500">Price paid<br /><input name="cost" type="number" step="1" min="0" inputMode="decimal" required className={box} /></label>
            <label className="text-xs text-gray-500">Date<br /><input name="acquiredAt" type="date" defaultValue={today} required className={box} /></label>
          </div>
          {/* Optional details — hidden by default (source/seller/funding/floor-plan preserved) */}
          <details className="rounded-xl border border-gray-800 bg-gray-900/60">
            <summary className="px-3 py-2 text-gray-400 text-sm cursor-pointer list-none">More details (optional) ▾</summary>
            <div className="px-3 pb-3 grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-500">Source<br /><select name="source" className={box} defaultValue="auction"><option value="auction">auction</option><option value="trade_in">trade-in</option><option value="private">private</option><option value="dealer">dealer</option><option value="other">other</option></select></label>
              <label className="text-xs text-gray-500">Seller<br /><input name="seller" className={box} /></label>
              <label className="text-xs text-gray-500">Paid from<br /><select name="account" className={box} defaultValue="unknown">{IN_SCOPE_ACCOUNTS.map((a) => <option key={a.ref} value={a.ref}>{a.ref}</option>)}</select></label>
              <label className="text-xs text-gray-500">Floor-plan lender<br /><input name="floorPlanLender" placeholder="Extraco" className={box} /></label>
              <label className="text-xs text-gray-500 flex items-center gap-2 col-span-2"><input name="floorPlanned" type="checkbox" className="w-5 h-5" /> Floor-planned</label>
            </div>
          </details>
          <button className="w-full bg-green-600 active:bg-green-700 text-white text-lg font-bold py-4 rounded-2xl">Save vehicle</button>
        </form>
      </details>

      {/* Inventory cards */}
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-white font-bold">Inventory <span className="text-gray-500 font-normal text-sm">({active.length} on lot)</span></h2>
      </div>
      {list.length === 0 ? <p className="text-gray-500 text-sm">No vehicles yet. Tap “+ Add a vehicle” to scan one in.</p> : (
        <div className="space-y-3">
          {list.map((r) => {
            const st = STATUS[r.status] ?? { c: 'bg-gray-800 text-gray-300 border-gray-700', label: r.status.replace('_', ' ') }
            const needsVin = !r.stockNumber
            return (
              <Link key={r.id} href={`/admin/auto-sales/${r.id}`} className="block rounded-2xl bg-gray-900 border border-gray-800 active:border-gray-700 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-white font-bold text-lg leading-tight">{[r.year, r.make, r.model].filter(Boolean).join(' ') || 'Unidentified vehicle'}</p>
                    <p className="text-gray-400 text-sm mt-0.5">{[r.color, r.stockNumber ?? null].filter(Boolean).join(' · ') || (r.vin ? `VIN …${r.vin.slice(-6)}` : '')}</p>
                  </div>
                  <span className={`shrink-0 text-[11px] px-2 py-1 rounded-full border ${st.c}`}>{st.label}</span>
                </div>
                <div className="flex items-center justify-between mt-3">
                  {needsVin
                    ? <span className="inline-flex items-center gap-1 text-sm font-semibold px-3 py-1.5 rounded-full border border-indigo-700 text-indigo-200">📷 Add / Scan VIN</span>
                    : <span className="text-gray-500 text-xs">In it: <b className="text-gray-200">{money(r.summary.knownInvestmentCents)}</b>{r.summary.historicalIncomplete && <span className="text-amber-400" title="historical costs may be incomplete"> ⚠</span>}</span>}
                  <span className="text-gray-600 text-xs">{r.daysOnLot != null ? `${r.daysOnLot}d on lot` : ''}</span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
      <p className="text-gray-700 text-[11px] mt-4">“In it” = what we paid + tracked costs so far. ⚠ = older costs may be incomplete.</p>
    </main>
  )
}
