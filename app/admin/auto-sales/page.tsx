/**
 * Auto-Sales B0 — Owned-Inventory list + Quick Acquisition (admin-gated by proxy.ts; ships dark
 * behind auto_sales_enabled). No money movement; no QBO/bank writes. VIN decode reuses the existing
 * NHTSA decoder (apps/vehicle-entry/vin). Historical-incomplete vehicles never show a definitive
 * "total cost basis".
 */
import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { autoSalesEnabled, autoSalesCutoverDate } from '@/apps/settings/db'
import { getInventoryList, createAcquisition } from '@/apps/auto-sales/db'
import { validateVIN, normalizeVIN, decodeVINFromNHTSA } from '@/apps/vehicle-entry/vin'
import { IN_SCOPE_ACCOUNTS } from '@/apps/auto-sales/types'
import AcquireVinFields from './AcquireVinFields'

export const dynamic = 'force-dynamic'
const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const COMPLETENESS: Record<string, { c: string; label: string }> = {
  complete: { c: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60', label: 'Complete' },
  partially_reconstructed: { c: 'bg-amber-950/40 text-amber-300 border-amber-900/60', label: 'Partially reconstructed' },
  historical_incomplete: { c: 'bg-amber-950/30 text-amber-300/90 border-amber-900/50', label: 'Historical costs incomplete' },
  needs_review: { c: 'bg-red-950/40 text-red-300 border-red-900/60', label: 'Needs review' },
}

async function acquireAction(fd: FormData) {
  'use server'
  const rawVin = String(fd.get('vin') ?? '').trim()
  const cost = Math.round(parseFloat(String(fd.get('cost') ?? '')) * 100)
  const acquiredAt = String(fd.get('acquiredAt') ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquiredAt) || !Number.isFinite(cost) || cost < 0) { revalidatePath('/admin/auto-sales'); return }
  // Reuse the existing VIN validator + NHTSA decoder (best-effort enrichment).
  let year = String(fd.get('year') ?? '') || null, make = String(fd.get('make') ?? '') || null, model = String(fd.get('model') ?? '') || null
  let vin: string | null = null, vinRaw: unknown = null
  if (rawVin) {
    const { valid } = validateVIN(rawVin)
    if (valid) {
      vin = normalizeVIN(rawVin)
      try { const d = await decodeVINFromNHTSA(vin); year = year || d.year; make = make || d.make; model = model || d.model; vinRaw = d } catch { /* NHTSA down — keep typed values */ }
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

const input = 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white w-full'
const card = 'rounded-2xl bg-gray-900 border border-gray-800 p-5'

export default async function AutoSalesPage() {
  const [enabled, cutover, list] = await Promise.all([autoSalesEnabled(), autoSalesCutoverDate(), getInventoryList()])
  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-8 py-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-white">Auto-Sales Inventory <span className="text-gray-500 font-semibold text-base">· Vehicle Financial System (B0)</span></h1>
        <Link href="/admin/auto-sales/backfill" className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300">Opening-inventory backfill →</Link>
      </div>
      <p className="text-gray-600 text-xs mb-4">Owned inventory · one canonical vehicle each · append-only financial ledger · admin-only · no money movement · go-forward cutover {cutover}{!enabled && ' · auto_sales_enabled OFF (preview)'}</p>

      {/* Quick Acquisition */}
      <div className={`${card} mb-6`}>
        <h2 className="text-white font-bold mb-1">Quick Acquisition</h2>
        <p className="text-gray-500 text-xs mb-3">Scan or type a VIN — we decode year/make/model (NHTSA) and auto-fill it, match or create the canonical vehicle, and generate a <b>PS-{'{'}last 4 of VIN{'}'}</b> stock number. Manual Y/M/M is only a fallback if decoding fails. Creates the inventory record + acquisition event.</p>
        <form action={acquireAction}>
          <AcquireVinFields />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="text-xs text-gray-500">Acquisition cost ($)<br /><input name="cost" type="number" step="0.01" min="0" required className={input} /></label>
            <label className="text-xs text-gray-500">Acquired date<br /><input name="acquiredAt" type="date" required className={input} /></label>
            <label className="text-xs text-gray-500">Source<br /><select name="source" className={input} defaultValue="auction"><option value="auction">auction</option><option value="trade_in">trade_in</option><option value="private">private</option><option value="dealer">dealer</option><option value="other">other</option></select></label>
            <label className="text-xs text-gray-500">Seller<br /><input name="seller" className={input} /></label>
            <label className="text-xs text-gray-500">Funding account<br /><select name="account" className={input} defaultValue="unknown">{IN_SCOPE_ACCOUNTS.map((a) => <option key={a.ref} value={a.ref}>{a.label}</option>)}</select></label>
            <label className="text-xs text-gray-500 flex items-end gap-2"><input name="floorPlanned" type="checkbox" className="mb-2.5" /> <span className="mb-2">Floor-planned</span></label>
            <label className="text-xs text-gray-500">Floor-plan lender<br /><input name="floorPlanLender" placeholder="Extraco" className={input} /></label>
            <div className="flex items-end"><button className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg w-full">Acquire vehicle</button></div>
          </div>
        </form>
      </div>

      {/* Inventory list */}
      <div className={card}>
        <h2 className="text-white font-bold mb-3">Owned inventory <span className="text-gray-600 text-sm font-normal">({list.length} vehicle{list.length === 1 ? '' : 's'})</span></h2>
        {list.length === 0 ? <p className="text-gray-500 text-sm">No vehicles yet. Acquire one above, or import your opening inventory.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-gray-600 text-xs uppercase tracking-wider">
              <th className="text-left font-normal py-1">Stock / Vehicle</th><th className="text-left font-normal py-1">Status</th>
              <th className="text-right font-normal py-1">Acq. cost</th><th className="text-right font-normal py-1">Verified add’l</th>
              <th className="text-right font-normal py-1">Known investment</th><th className="text-right font-normal py-1">Days</th><th className="text-left font-normal py-1 pl-3">Completeness</th>
            </tr></thead>
            <tbody>
              {list.map((r) => {
                const cm = COMPLETENESS[r.completeness] ?? COMPLETENESS.needs_review
                return (
                  <tr key={r.id} className="border-b border-gray-800">
                    <td className="py-2">{r.stockNumber
                      ? <Link href={`/admin/auto-sales/${r.id}`} className="text-indigo-300 font-medium">{r.stockNumber}</Link>
                      : <Link href={`/admin/auto-sales/${r.id}`} className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-indigo-700 text-indigo-200">📷 Add / Scan VIN →</Link>}
                      <span className="block text-gray-500 text-xs">{[r.year, r.make, r.model, r.color].filter(Boolean).join(' ') || 'Unidentified'}{r.vin ? ` · ${r.vin.slice(-6)}` : ''}</span></td>
                    <td className="py-2 text-gray-400 capitalize">{r.status.replace('_', ' ')}</td>
                    <td className="py-2 text-right tabular-nums text-white">{money(r.summary.acquisitionCostCents)}</td>
                    <td className="py-2 text-right tabular-nums text-gray-300">{money(r.summary.verifiedAdditionalCents)}</td>
                    <td className="py-2 text-right tabular-nums text-white">{money(r.summary.knownInvestmentCents)}{r.summary.historicalIncomplete && <span className="text-amber-400" title="historical costs incomplete"> *</span>}</td>
                    <td className="py-2 text-right tabular-nums text-gray-400">{r.daysOnLot ?? '—'}</td>
                    <td className="py-2 pl-3"><span className={`text-[10px] px-2 py-0.5 rounded-full border ${cm.c}`}>{cm.label}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <p className="text-gray-600 text-xs mt-2"><span className="text-amber-400">*</span> Known investment = acquisition + <b>verified</b> additional costs only. It is NOT a definitive total cost basis when historical costs are incomplete.</p>
      </div>
    </main>
  )
}
