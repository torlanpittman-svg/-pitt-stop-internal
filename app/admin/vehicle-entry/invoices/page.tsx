import Link from 'next/link'
import { listInvoiceBatches, countVehiclesInBatch, countPendingForDealership } from '@/apps/vehicle-entry/invoice-db'
import { listDealerships } from '@/apps/vehicle-entry/db'
import InvoiceBatchManager from './InvoiceBatchManager'

export const dynamic = 'force-dynamic'

export default async function InvoiceBatchesPage() {
  const [batches, dealerships] = await Promise.all([
    listInvoiceBatches(),
    listDealerships(false),
  ])

  const batchesWithCounts = await Promise.all(
    batches.map(async (b) => {
      const dealer = dealerships.find(d => d.id === b.dealershipId)
      const [vehicleCount, pendingCount] = await Promise.all([
        countVehiclesInBatch(b.id),
        dealer ? countPendingForDealership(b.dealershipId, dealer.stockPrefix) : Promise.resolve(0),
      ])
      return { ...b, vehicleCount, pendingCount }
    })
  )

  return (
    <main className="max-w-5xl mx-auto px-6 py-10">
      <div className="flex items-center gap-2 text-sm mb-6">
        <Link href="/admin" className="text-gray-500 hover:text-white transition-colors">Admin</Link>
        <span className="text-gray-700">›</span>
        <Link href="/admin/vehicle-entry" className="text-gray-500 hover:text-white transition-colors">Vehicle Entries</Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-300">Invoice Batches</span>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Invoice Batches</h1>
        <p className="text-gray-500 mt-0.5 text-sm">
          One active batch per dealership. Only active batches receive vehicles from QuickBooks sync.
        </p>
      </div>

      <InvoiceBatchManager
        initialBatches={batchesWithCounts}
        dealerships={dealerships}
      />
    </main>
  )
}
