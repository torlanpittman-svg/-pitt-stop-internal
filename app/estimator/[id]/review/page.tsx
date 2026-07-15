import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getEstimateWithDetails } from '@/apps/estimator/db'
import EstimateReviewClient from './EstimateReviewClient'

export const dynamic = 'force-dynamic'

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} hr`
  return `${h} hr ${m} min`
}

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const estimate = await getEstimateWithDetails(id)
  if (!estimate) notFound()
  if (estimate.status === 'draft' || estimate.status === 'photos_complete') {
    redirect(`/estimator/${id}/analyzing`)
  }
  if (estimate.status === 'approved') {
    redirect(`/estimator/${id}/saved`)
  }

  const activeItems = estimate.lineItems.filter(li => li.included)
  const totalMinutes = activeItems.reduce((sum, li) => sum + (li.laborMinutes ?? 0), 0)
  const totalCents   = activeItems.reduce((sum, li) => sum + (li.lineTotalCents ?? 0), 0)

  const vehicleLabel = [estimate.vehicleYear, estimate.vehicleMake, estimate.vehicleModel]
    .filter(Boolean).join(' ') || 'Vehicle'

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-6 pb-2 shrink-0">
        <Link
          href={`/estimator/${id}/photo-review`}
          className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
        >
          ← Photos
        </Link>
        <span className="text-white font-semibold">Estimate Review</span>
        <div className="w-14" />
      </div>

      {/* Step indicator */}
      <div className="px-5 pt-2 pb-4 shrink-0">
        <div className="flex items-center gap-2">
          {[1,2,3,4,5,6,7].map(n => (
            <div
              key={n}
              className={`h-1 flex-1 rounded-full ${n <= 6 ? 'bg-blue-500' : 'bg-gray-800'}`}
            />
          ))}
        </div>
        <p className="text-gray-500 text-xs mt-2">Step 6 of 7 — Review Estimate</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-36">

        {/* Vehicle card */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 mb-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-white font-bold text-lg">{vehicleLabel}</p>
              {estimate.vehicleColor && (
                <p className="text-gray-500 text-sm">{estimate.vehicleColor}{estimate.vehicleSize ? ` · ${estimate.vehicleSize}` : ''}</p>
              )}
            </div>
            <div className="text-right shrink-0 ml-3">
              <p className="text-gray-500 text-xs">{estimate.customerName}</p>
              {estimate.customerPhone && (
                <p className="text-gray-600 text-xs">{estimate.customerPhone}</p>
              )}
            </div>
          </div>
          {estimate.serviceFocus && (
            <div className="mt-2 inline-block bg-gray-800 text-gray-400 text-xs px-2.5 py-1 rounded-full">
              {estimate.serviceFocus.replace('_', ' ')}
            </div>
          )}
        </div>

        {/* Placeholder notice */}
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl px-4 py-3 mb-4">
          <p className="text-yellow-400 text-xs font-semibold">Placeholder Estimate</p>
          <p className="text-yellow-700 text-xs mt-0.5">
            AI pricing is coming in the next update. These are standard service estimates.
          </p>
        </div>

        {/* Line items */}
        <div className="space-y-2 mb-4">
          <p className="text-gray-500 text-xs uppercase tracking-wide font-medium">Services</p>
          {activeItems.map(item => (
            <div key={item.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-white text-sm font-medium leading-snug flex-1">
                  {item.description}
                </p>
                <p className="text-white font-bold text-sm shrink-0">
                  {formatCents(item.lineTotalCents)}
                </p>
              </div>
              {item.laborMinutes != null && (
                <p className="text-gray-600 text-xs mt-1">
                  Est. {formatMinutes(item.laborMinutes)}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* Summary */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Est. Labor Time</span>
            <span className="text-white font-medium">{formatMinutes(totalMinutes)}</span>
          </div>
          <div className="flex items-center justify-between border-t border-gray-800 pt-2">
            <span className="text-gray-400 font-semibold">Total</span>
            <span className="text-white font-bold text-xl">{formatCents(totalCents)}</span>
          </div>
        </div>

        {/* Photo thumbnails */}
        {estimate.photos.length > 0 && (
          <div className="mt-4">
            <p className="text-gray-500 text-xs uppercase tracking-wide font-medium mb-2">
              Photos ({estimate.photos.length})
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {estimate.photos.map(photo => (
                <div
                  key={photo.id}
                  className="w-16 h-16 rounded-lg overflow-hidden shrink-0 bg-gray-900 border border-gray-800"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.photoUrl}
                    alt={photo.role}
                    className="w-full h-full object-cover"
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sticky footer with approve */}
      <EstimateReviewClient
        estimateId={id}
        recommendedPriceCents={estimate.recommendedPriceCents}
        totalCents={totalCents}
      />
    </main>
  )
}
