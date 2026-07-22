import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getEstimate } from '@/apps/estimator/db'

export const dynamic = 'force-dynamic'

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

export default async function SavedPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const estimate = await getEstimate(id)
  if (!estimate) notFound()

  const vehicleLabel = [estimate.vehicleYear, estimate.vehicleMake, estimate.vehicleModel]
    .filter(Boolean).join(' ') || 'Vehicle'

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      {/* Step indicator */}
      <div className="px-5 pt-10 pb-4 shrink-0">
        <div className="flex items-center gap-2">
          {[1,2,3,4,5,6,7].map(n => (
            <div key={n} className="h-1 flex-1 rounded-full bg-blue-500" />
          ))}
        </div>
        <p className="text-gray-500 text-xs mt-2">Step 7 of 7 — Estimate Saved</p>
      </div>

      {/* Success content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-6">

        {/* Icon */}
        <div className="w-20 h-20 rounded-full bg-green-900/60 border-2 border-green-600 flex items-center justify-center">
          <span className="text-green-400 text-3xl font-bold">✓</span>
        </div>

        {/* Headline */}
        <div className="text-center">
          <h1 className="text-white text-2xl font-bold">Estimate Saved</h1>
          {estimate.estimateNumber && (
            <p className="text-gray-500 text-sm mt-1 font-mono">{estimate.estimateNumber}</p>
          )}
        </div>

        {/* Details card */}
        <div className="w-full max-w-sm bg-gray-800 border border-gray-700 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Customer</span>
            <span className="text-white font-medium">{estimate.customerName}</span>
          </div>
          {estimate.customerPhone && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500">Phone</span>
              <span className="text-gray-300">{estimate.customerPhone}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Vehicle</span>
            <span className="text-white font-medium text-right">{vehicleLabel}</span>
          </div>
          {estimate.vehicleColor && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500">Color</span>
              <span className="text-gray-300">{estimate.vehicleColor}</span>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-gray-700 pt-3">
            <span className="text-gray-400 font-semibold">Approved Price</span>
            <span className="text-white font-bold text-lg">
              {formatCents(estimate.approvedPriceCents)}
            </span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="px-6 pb-10 pt-4 shrink-0 space-y-3">
        <Link
          href="/estimator"
          className="block w-full py-5 rounded-2xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-bold text-xl text-center transition-colors shadow-lg"
        >
          Create Another Estimate
        </Link>
        <Link
          href="/"
          className="block w-full py-3 rounded-2xl text-gray-500 hover:text-gray-300 text-sm text-center transition-colors"
        >
          Return to Pitt Stop OS
        </Link>
      </div>
    </main>
  )
}
