import { NextResponse } from 'next/server'
import { getEstimateWithDetails, updateEstimate, createEstimateLineItem } from '@/apps/estimator/db'
import { runEstimatorAnalysis, findingPriceCents } from '@/apps/estimator/ai'

export const dynamic = 'force-dynamic'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const estimate = await getEstimateWithDetails(id)
  if (!estimate) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (estimate.photos.length === 0) {
    return NextResponse.json({ error: 'No photos to analyze' }, { status: 400 })
  }

  await updateEstimate(id, { status: 'ai_pending' })

  try {
    const result = await runEstimatorAnalysis(estimate.photos, estimate.serviceFocus)

    // Write one line item per AI finding.
    // ai_* fields are immutable originals; confirmed fields are seeded from
    // AI values so the review screen shows data before the employee edits anything.
    for (let i = 0; i < result.findings.length; i++) {
      const f          = result.findings[i]
      const priceCents = findingPriceCents(f.laborMinutes)

      await createEstimateLineItem({
        estimateId:   id,
        displayOrder: i,

        // AI originals — never overwritten after this point
        aiCategory:    f.category,
        aiLocation:    f.location,
        aiDamageType:  f.damageType,
        aiSeverity:    f.severity,
        aiDescription: f.description,
        aiServiceCode: f.serviceCode,
        aiLaborMinutes: f.laborMinutes,
        aiConfidence:   String(f.confidence),
        aiIsTimeTrap:   f.isTimeTrap,

        // Employee-confirmed — seeded from AI, editable on review screen
        description:    f.description,
        serviceCode:    f.serviceCode,
        severity:       f.severity,
        laborMinutes:   f.laborMinutes,
        unitPriceCents: priceCents,
        lineTotalCents: priceCents,
        included:       true,
        wasAddedByEmployee: false,
      })
    }

    await updateEstimate(id, {
      // AI vehicle identification — immutable originals
      aiVehicleYear:       result.vehicle.year,
      aiVehicleMake:       result.vehicle.make,
      aiVehicleModel:      result.vehicle.model,
      aiVehicleColor:      result.vehicle.color,
      aiVehicleSize:       result.vehicle.size,
      aiDifficultyRating:  result.vehicle.difficultyRating,
      aiTotalLaborMinutes: result.totalLaborMinutes,
      aiNotes:             result.notes,

      // Pricing
      recommendedPriceCents: result.recommendedPriceCents,

      // AI metadata
      promptVersion: result.promptVersion,
      modelName:     result.modelName,
      rawAiResponse: result.rawResponse as never,

      status: 'needs_review',
    })

    return NextResponse.json({
      estimateId:   id,
      status:       'needs_review',
      findingCount: result.findings.length,
      timeTrapCount: result.findings.filter(f => f.isTimeTrap).length,
      totalLaborMinutes: result.totalLaborMinutes,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[estimator] POST /estimates/[id]/analyze failed:', message)

    // Graceful degradation: set status to needs_review so employee can proceed
    // manually rather than seeing a hard error.
    await updateEstimate(id, {
      status:        'needs_review',
      promptVersion: 'v1-error',
      aiNotes:       `Analysis error: ${message}`,
    }).catch(() => {}) // best-effort; don't double-fault

    return NextResponse.json({
      estimateId: id,
      status:     'needs_review',
      error:      'analysis_failed',
      message,
    })
  }
}
