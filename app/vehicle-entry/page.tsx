import Link from 'next/link'

export default function VehicleEntryHome() {
  const isPilotMode = process.env.PILOT_MODE === 'true'

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">

      {/* Nav bar */}
      <div className="flex items-center justify-between px-6 pt-6 pb-2">
        <Link href="/" className="text-gray-500 text-sm hover:text-gray-300 transition-colors">
          ← Pitt Stop OS
        </Link>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-8">

        <div className="text-center">
          <p className="text-gray-500 text-sm font-medium uppercase tracking-widest mb-1">Pitt Stop OS</p>
          <h1 className="text-white text-3xl font-bold">Dealer Vehicle Entry</h1>
          {isPilotMode && (
            <span className="mt-3 inline-block bg-yellow-900/60 border border-yellow-700 text-yellow-300 text-xs font-semibold px-3 py-1 rounded-full">
              TEST MODE — Mock QuickBooks Active
            </span>
          )}
        </div>

        <div className="w-full max-w-sm space-y-3">
          <Link
            href="/vehicle-entry/capture"
            className="block w-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-bold text-xl py-6 rounded-2xl text-center transition-colors shadow-lg"
          >
            Scan Dealer Key Tag
          </Link>

          <Link
            href="/vehicle-entry/vin"
            className="block w-full text-center text-gray-500 text-sm py-3"
          >
            Tag unreadable? Scan VIN instead →
          </Link>
        </div>

      </div>

    </main>
  )
}
