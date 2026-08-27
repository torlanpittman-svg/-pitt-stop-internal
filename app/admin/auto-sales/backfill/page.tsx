/** Opening-Inventory Backfill — import the authoritative opening snapshot (~10 vehicles), review-based,
 *  facts-only. Admin-gated by proxy.ts. No money movement; no fabricated historical costs. */
import Link from 'next/link'
import { autoSalesCutoverDate } from '@/apps/settings/db'
import BackfillClient from './BackfillClient'

export const dynamic = 'force-dynamic'

export default async function BackfillPage() {
  const cutover = await autoSalesCutoverDate()
  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-8 py-8 max-w-5xl mx-auto">
      <Link href="/admin/auto-sales" className="text-gray-500 text-xs">← Inventory</Link>
      <h1 className="text-2xl font-bold text-white mt-1">Opening-Inventory Backfill</h1>
      <p className="text-gray-600 text-xs mb-4">Import the authoritative opening snapshot. Known facts only (year/make/model/VIN/color/acquisition cost + date). Enrichment happens only on a <b>high-confidence full-VIN match</b> — proximity of date/vendor/amount is never sufficient. Historical recon costs stay <b>incomplete</b>, clearly separated from go-forward tracking (cutover {cutover}).</p>
      <div className="rounded-2xl bg-gray-900 border border-gray-800 p-5">
        <BackfillClient />
      </div>
    </main>
  )
}
