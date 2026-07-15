import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getEstimateWithDetails } from '@/apps/estimator/db'
import PhotoReviewClient from './PhotoReviewClient'

export const dynamic = 'force-dynamic'

const ROLE_LABELS: Record<string, string> = {
  driver_side:    'Driver Side',
  passenger_side: 'Passenger Side',
  front:          'Front',
  rear:           'Rear',
  interior_front: 'Front Interior',
  interior_rear:  'Rear Seats',
  interior_floor: 'Floor & Carpet',
  trunk:          'Trunk / Cargo',
}

export default async function PhotoReviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const estimate = await getEstimateWithDetails(id)
  if (!estimate) notFound()
  if (estimate.photos.length === 0) redirect(`/estimator/${id}/photos`)

  const sortedPhotos = [...estimate.photos].sort((a, b) => a.captureOrder - b.captureOrder)

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-6 pb-2 shrink-0">
        <Link
          href={`/estimator/${id}/photos`}
          className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
        >
          ← Retake
        </Link>
        <span className="text-white font-semibold">Review Photos</span>
        <div className="w-14" />
      </div>

      {/* Step indicator */}
      <div className="px-5 pt-2 pb-4 shrink-0">
        <div className="flex items-center gap-2">
          {[1,2,3,4,5,6,7].map(n => (
            <div
              key={n}
              className={`h-1 flex-1 rounded-full ${n <= 4 ? 'bg-blue-500' : 'bg-gray-800'}`}
            />
          ))}
        </div>
        <p className="text-gray-500 text-xs mt-2">Step 4 of 7 — Review Photos</p>
      </div>

      {/* Photo grid */}
      <div className="flex-1 overflow-y-auto px-5 pb-32">
        <p className="text-gray-400 text-sm mb-4">
          {sortedPhotos.length} photo{sortedPhotos.length !== 1 ? 's' : ''} captured.
          Everything look good?
        </p>

        <div className="grid grid-cols-2 gap-3">
          {sortedPhotos.map(photo => (
            <div key={photo.id} className="space-y-1">
              <div className="aspect-[4/3] rounded-xl overflow-hidden bg-gray-900 border border-gray-800">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.photoUrl}
                  alt={photo.role}
                  className="w-full h-full object-cover"
                />
              </div>
              <p className="text-gray-500 text-xs text-center">
                {ROLE_LABELS[photo.role] ?? photo.role}
              </p>
            </div>
          ))}
        </div>

        {/* Retake prompt if fewer than expected */}
        {sortedPhotos.length < 8 && (
          <div className="mt-4 bg-yellow-900/40 border border-yellow-700/60 rounded-xl px-4 py-3">
            <p className="text-yellow-300 text-sm font-medium">
              {8 - sortedPhotos.length} photo{8 - sortedPhotos.length !== 1 ? 's' : ''} skipped
            </p>
            <p className="text-yellow-600 text-xs mt-0.5">
              More photos help produce a more accurate estimate.
            </p>
          </div>
        )}
      </div>

      {/* CTA */}
      <PhotoReviewClient estimateId={id} />
    </main>
  )
}
