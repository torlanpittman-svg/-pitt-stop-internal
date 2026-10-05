import { notFound, redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { authenticatedActor, isManagerRole } from '@/apps/auth/employee-guard'
import { getOrderWithContext } from '@/apps/workflow/db'
import { getEstimateRow } from '@/apps/workflow/estimate-db'
import { estimateIntakes } from '@/apps/estimates/schema'
import { listOrderPhotos } from '@/apps/order-photos/db'
import { isPhotoId } from '@/apps/order-photos/access'
import { getDb } from '@/platform/db'
import PhotoPrintControls from '@/app/components/PhotoPrintControls'
import PhotoPrintSheets from '@/app/components/PhotoPrintSheets'

export const dynamic = 'force-dynamic'

export default async function PhotoPacketPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await authenticatedActor()
  if (!actor || !isManagerRole(actor.role)) redirect('/')
  const { id } = await params
  if (!isPhotoId(id)) notFound()
  const order = await getOrderWithContext(id)
  if (!order) notFound()
  const [photos, estimate, intakes] = await Promise.all([
    listOrderPhotos(id), getEstimateRow(id),
    getDb().select({ number: estimateIntakes.qbEstimateNumber }).from(estimateIntakes).where(eq(estimateIntakes.orderId, id)).limit(1),
  ])
  const selected = photos.filter((photo) => photo.included)
  return <main className="photo-document" style={{ background: '#fff', color: '#111', minHeight: '100vh', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <PhotoPrintControls backHref={order.status === 'estimate' ? `/orders/${id}/estimate` : `/orders/${id}`} />
      {selected.length === 0 ? <p>No photos selected. Return to the vehicle and select the photos to include.</p> : <div className="photo-packet-only">
        <PhotoPrintSheets photos={selected} details={{
          customer: order.customerName?.trim() || 'Customer',
          vehicle: [order.vehicle.year, order.vehicle.make, order.vehicle.model].filter(Boolean).join(' ') || 'Vehicle',
          vin: order.vehicle.vin, orderNumber: order.orderNumber,
          invoiceNumber: estimate?.qbInvoiceNumber, estimateNumber: intakes[0]?.number,
        }} />
      </div>}
    </div>
  </main>
}
