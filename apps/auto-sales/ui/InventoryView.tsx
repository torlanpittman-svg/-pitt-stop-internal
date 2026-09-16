/**
 * Auto-Sales — Owned inventory + Quick Acquisition (shared view). Rendered by the public employee
 * route (/auto-sales, admin=false) AND the gated admin route (/admin/auto-sales, admin=true). Same
 * domain model + components — no second system. Admin-only affordances (opening-inventory backfill
 * link) render only when admin. Employee operations (view, acquire, VIN scan) need no password.
 */
import Link from 'next/link'
import { autoSalesEnabled } from '@/apps/settings/db'
import { authorizedManager } from '@/apps/auth/employee-guard'
import { getInventoryList } from '@/apps/auto-sales/db'
import { IN_SCOPE_ACCOUNTS } from '@/apps/auto-sales/types'
import { acquireAction } from '@/apps/auto-sales/actions'
import AcquireVinFields from './AcquireVinFields'

const money = (c: number | null | undefined) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const STATUS: Record<string, { c: string; label: string }> = {
  acquired: { c: 'bg-gray-800 text-gray-300 border-gray-700', label: 'In inventory' },
  in_recon: { c: 'bg-blue-950/40 text-blue-300 border-blue-900/60', label: 'In recon' },
  listed: { c: 'bg-blue-950/40 text-blue-300 border-blue-900/60', label: 'Listed' },
  sale_pending: { c: 'bg-blue-950/40 text-blue-300 border-blue-900/60', label: 'Sale pending' },
  sold: { c: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60', label: 'Sold' },
  delivered: { c: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60', label: 'Delivered' },
}
const box = 'bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-white w-full'

export default async function InventoryView({ admin }: { admin: boolean }) {
  const [enabled, list, manager] = await Promise.all([autoSalesEnabled(), getInventoryList(), authorizedManager()])
  const isManager = !!manager
  const today = new Date().toISOString().slice(0, 10)
  const SOLD = ['sold', 'delivered', 'wholesaled']
  const active = list.filter((r) => !SOLD.includes(r.status))
  const soldList = list.filter((r) => SOLD.includes(r.status))
  const base = admin ? '/admin/auto-sales' : '/auto-sales'

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-white">Auto Sales</h1>
        <Link href={admin ? '/admin' : '/'} className="text-gray-500 text-sm">{admin ? 'Admin' : 'Home'}</Link>
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

      {/* Inventory cards — active (available-for-sale) only; sold vehicles move to the history section. */}
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-white font-bold">Inventory <span className="text-gray-500 font-normal text-sm">({active.length} on lot)</span></h2>
        {isManager && <Link href="/auto-sales/report" className="text-indigo-300 text-xs underline">Monthly report</Link>}
      </div>
      {active.length === 0 ? <p className="text-gray-500 text-sm">{list.length === 0 ? 'No vehicles yet. Tap “+ Add a vehicle” to scan one in.' : 'No vehicles on the lot — all sold.'}</p> : (
        <div className="space-y-3">
          {active.map((r) => <VehicleCard key={r.id} r={r} base={base} admin={admin} />)}
        </div>
      )}

      {/* Sold / history — hidden by default; nothing is deleted. */}
      {soldList.length > 0 && (
        <details className="mt-5 rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
          <summary className="px-4 py-3 cursor-pointer list-none text-gray-300 font-semibold flex items-center justify-between">Sold &amp; history <span className="text-gray-500 text-sm">{soldList.length} ▾</span></summary>
          <div className="px-4 pb-4 space-y-3">
            {soldList.map((r) => <VehicleCard key={r.id} r={r} base={base} admin={admin} />)}
          </div>
        </details>
      )}

      <p className="text-gray-700 text-[11px] mt-4">“In it” = what we paid + tracked costs so far.{admin && ' ⚠ = older costs may be incomplete.'}</p>
      {admin && <Link href="/admin/auto-sales/backfill" className="block text-gray-600 text-xs underline mt-2">Opening-inventory import</Link>}
    </main>
  )
}

function VehicleCard({ r, base, admin }: { r: Awaited<ReturnType<typeof getInventoryList>>[number]; base: string; admin: boolean }) {
  const st = STATUS[r.status] ?? { c: 'bg-gray-800 text-gray-300 border-gray-700', label: r.status.replace('_', ' ') }
  const needsVin = !r.stockNumber
  const sold = ['sold', 'delivered', 'wholesaled'].includes(r.status)
  return (
    <Link href={`${base}/${r.id}`} className="block rounded-2xl bg-gray-900 border border-gray-800 active:border-gray-700 p-4">
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
          : sold && r.result.indicativeProfitCents != null
            ? <span className="text-gray-500 text-xs">Est. profit: <b className={r.result.indicativeProfitCents < 0 ? 'text-red-400' : 'text-emerald-300'}>{money(r.result.indicativeProfitCents)}</b></span>
            : <span className="text-gray-500 text-xs">In it: <b className="text-gray-200">{money(r.summary.knownInvestmentCents)}</b>{admin && r.summary.historicalIncomplete && <span className="text-amber-400" title="historical costs may be incomplete"> ⚠</span>}</span>}
        <span className="text-gray-600 text-xs">{sold ? (r.status === 'delivered' ? 'delivered' : 'sold') : r.daysOnLot != null ? `${r.daysOnLot}d on lot` : ''}</span>
      </div>
    </Link>
  )
}
