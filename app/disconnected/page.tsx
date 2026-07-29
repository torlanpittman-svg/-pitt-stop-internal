import Link from 'next/link'

export const metadata = { title: 'Disconnected — Pitt Stop OS' }

export default function DisconnectedPage() {
  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold text-white mb-3">QuickBooks disconnected</h1>
        <p className="text-gray-400 mb-6">
          Pitt Stop OS no longer has access to this QuickBooks company. Dealer check-ins
          will queue until you reconnect, so no work is lost.
        </p>
        <Link
          href="/admin/integrations/quickbooks"
          className="inline-block px-5 py-3 rounded-xl bg-green-600 hover:bg-green-500 text-white font-semibold"
        >
          Reconnect QuickBooks
        </Link>
      </div>
    </main>
  )
}
