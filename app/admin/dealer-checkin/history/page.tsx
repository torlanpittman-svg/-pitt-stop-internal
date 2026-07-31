import Link from 'next/link'
import { listRecentScans } from '@/apps/dealer-checkin/db'
import { extractStockPrefix } from '@/apps/dealer-checkin/rules'
import { listDealerships } from '@/apps/vehicle-entry/db'
import HistoryList, { type ScanDTO } from './HistoryList'

export const dynamic = 'force-dynamic'

export default async function ScanHistoryPage() {
  const [scans, dealerships] = await Promise.all([listRecentScans(100), listDealerships()])

  // Dealer name lookups: the confirmed dealer id (source of truth) wins; the stock
  // prefix (Auto Group owns S and T) is only a fallback for older scans.
  const prefixToDealer = new Map<string, string>()
  const idToDealer = new Map<string, string>()
  for (const d of dealerships) {
    if (d.stockPrefix) prefixToDealer.set(d.stockPrefix.toUpperCase(), d.name)
    idToDealer.set(d.id, d.name)
  }

  const dtos: ScanDTO[] = scans.map((s) => {
    const prefix = extractStockPrefix(s.stockNumber)
    return {
      id: s.id,
      createdAt: (s.createdAt as Date).toISOString(),
      dealer:
        (s.dealershipId && idToDealer.get(s.dealershipId)) ||
        (prefix && prefixToDealer.get(prefix.toUpperCase())) ||
        (prefix ? `prefix ${prefix}` : '—'),
      stockNumber: s.stockNumber,
      vehicle: [s.year, s.make, s.model, s.color].filter(Boolean).join(' '),
      invoiceNumber: s.qbInvoiceNumber,
      status: s.status,
      syncStatus: s.qbSyncStatus,
      photoUrl: s.photoUrl,
      imageDeleted: Boolean(s.imageDeletedAt),
    }
  })

  return (
    <main className="min-h-screen bg-gray-950 px-6 pt-10 pb-16">
      <div className="max-w-3xl mx-auto">
        <Link href="/admin/dealer-checkin" className="text-gray-500 text-sm block mb-6 hover:text-gray-300">← Dealer Check-In</Link>
        <h1 className="text-2xl font-bold text-white mb-1">Scan History</h1>
        <p className="text-gray-500 text-sm mb-8">
          Original tag image, decoded vehicle, dealer, and QuickBooks invoice for every scan. Tap an image to view it full-size. Images auto-delete per the retention policy; &ldquo;Mark reviewed&rdquo; removes one now.
        </p>
        <HistoryList scans={dtos} />
      </div>
    </main>
  )
}
