import { notFound } from 'next/navigation'
import { getEstimate } from '@/apps/estimator/db'
import { detectLayout } from '@/apps/estimator/vehicle-layout'
import PhotoCapture from './PhotoCapture'

export const dynamic = 'force-dynamic'

export default async function PhotosPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const estimate = await getEstimate(id)
  if (!estimate) notFound()

  const layoutInference = detectLayout({
    bodyClass: estimate.vehicleBodyClass,
    make:      estimate.vehicleMake,
    model:     estimate.vehicleModel,
  })

  return (
    <PhotoCapture
      estimateId={id}
      serviceFocus={estimate.serviceFocus}
      layoutInference={layoutInference}
    />
  )
}
