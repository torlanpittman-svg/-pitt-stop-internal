import Link from 'next/link'

export default function VehicleEntryHome() {
  const isPilotMode = process.env.PILOT_MODE === 'true'

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6">

      <div className="w-full max-w-sm flex flex-col items-center gap-8">

        {/* Header */}
        <div className="text-center">
          <p className="text-gray-500 text-sm font-medium uppercase tracking-widest mb-1">Pitt Stop</p>
          <h1 className="text-white text-3xl font-bold">Vehicle Entry</h1>
          {isPilotMode && (
            <span className="mt-2 inline-block bg-yellow-900/60 border border-yellow-700 text-yellow-300 text-xs font-semibold px-3 py-1 rounded-full">
              TEST MODE — Mock QuickBooks Active
            </span>
          )}
        </div>

        {/* Scan button */}
        <Link
          href="/vehicle-entry/capture"
          className="w-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-bold text-xl py-6 rounded-2xl text-center transition-colors shadow-lg"
        >
          Scan Next Vehicle
        </Link>

        {/* VIN fallback */}
        <div className="flex flex-col items-center gap-2 text-center">
          <Link
            href="/vehicle-entry/vin"
            className="text-gray-400 text-sm"
          >
            Tag unreadable? Scan VIN instead →
          </Link>
        </div>

      </div>

    </main>
  )
}
