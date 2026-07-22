import { getDb } from '@/platform/db'
import { estimatorLearningEvents } from './schema'
import { desc, eq } from 'drizzle-orm'
import { estimates, estimatePhotos, estimateLineItems } from '@/apps/estimator/schema'

export type EstimatorLearningEvent = typeof estimatorLearningEvents.$inferSelect

export type LineItemSnapshot = {
  id:               string
  description:      string | null
  serviceCode:      string | null
  aiCents:          number | null  // unitPriceCents at analysis time
  finalCents:       number | null  // same (line items aren't individually editable yet)
  included:         boolean
  wasAddedByEmployee: boolean
}

export async function recordEstimatorLearningEvent(estimateId: string): Promise<void> {
  const db = getDb()

  const [estimate, photos, lineItems] = await Promise.all([
    db.select().from(estimates).where(eq(estimates.id, estimateId)).limit(1),
    db.select().from(estimatePhotos).where(eq(estimatePhotos.estimateId, estimateId)),
    db.select().from(estimateLineItems).where(eq(estimateLineItems.estimateId, estimateId)),
  ])

  const est = estimate[0]
  if (!est) return

  const aiCents       = est.recommendedPriceCents
  const approvedCents = est.approvedPriceCents
  const pricingWasCorrected =
    aiCents !== null && approvedCents !== null && aiCents !== approvedCents

  const lineItemsSnapshot: LineItemSnapshot[] = lineItems.map(li => ({
    id:               li.id,
    description:      li.description,
    serviceCode:      li.serviceCode,
    aiCents:          li.unitPriceCents,
    finalCents:       li.unitPriceCents,
    included:         li.included,
    wasAddedByEmployee: li.wasAddedByEmployee,
  }))

  await db.insert(estimatorLearningEvents).values({
    estimateId,
    serviceFocus:            est.serviceFocus,
    vehicleYear:             est.vehicleYear,
    vehicleMake:             est.vehicleMake,
    vehicleModel:            est.vehicleModel,
    vehicleColor:            est.vehicleColor,
    vehicleVin:              est.vin,
    vehicleWasCorrected:     est.vehicleWasCorrected,
    photoCount:              photos.length,
    aiRecommendedPriceCents: aiCents,
    approvedPriceCents:      approvedCents,
    pricingWasCorrected,
    priceAdjustmentCents:    aiCents !== null && approvedCents !== null
      ? approvedCents - aiCents
      : null,
    lineItemCount:     lineItems.length,
    lineItemsSnapshot: lineItemsSnapshot as never,
    promptVersion:     est.promptVersion,
    modelName:         est.modelName,
  })
}

export async function listEstimatorLearningEvents(limit = 200): Promise<EstimatorLearningEvent[]> {
  const db = getDb()
  return db
    .select()
    .from(estimatorLearningEvents)
    .orderBy(desc(estimatorLearningEvents.createdAt))
    .limit(limit) as Promise<EstimatorLearningEvent[]>
}
