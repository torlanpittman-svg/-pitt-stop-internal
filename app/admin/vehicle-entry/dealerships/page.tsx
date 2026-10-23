import Link from 'next/link'
import { listDealerships } from '@/apps/vehicle-entry/db'
import DealershipManager from './DealershipManager'

export const dynamic = 'force-dynamic'

export default async function AdminDealershipsPage() {
  const dealerships = await listDealerships()

  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-center gap-2 text-sm mb-6">
        <Link href="/admin" className="text-gray-500 hover:text-white transition-colors">Admin</Link>
        <span className="text-gray-700">›</span>
        <Link href="/admin/vehicle-entry" className="text-gray-500 hover:text-white transition-colors">Vehicle Entry</Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-300">Dealerships</span>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Source Dealerships</h1>
        <p className="text-gray-500 mt-1 text-sm">
          Dealerships for Dealer Check-In and dealer invoicing. A stock prefix (e.g.{' '}
          <span className="font-mono text-gray-400">K</span>) auto-detects the dealer from the stock number;
          dealers without a prefix (stock = last 8 of VIN) are picked from the dealer list.
        </p>
      </div>

      <DealershipManager initial={dealerships} />
    </main>
  )
}
