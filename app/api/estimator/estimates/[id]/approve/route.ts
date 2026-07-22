import { NextResponse } from 'next/server'
import { getEstimate, updateEstimate, generateEstimateNumber } from '@/apps/estimator/db'
import { recordEstimatorLearningEvent } from '@/apps/ai-learning/db'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const estimate = await getEstimate(id)
    if (!estimate) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const body = await req.json().catch(() => ({})) as { approvedPriceCents?: number }
    const approvedPrice = body.approvedPriceCents ?? estimate.recommendedPriceCents

    const estimateNumber = estimate.estimateNumber ?? generateEstimateNumber()

    const updated = await updateEstimate(id, {
      status:             'approved',
      estimateNumber,
      approvedPriceCents: approvedPrice,
      employeeApprovedAt: new Date(),
    })

    // Write learning event — awaited so it completes before the serverless function exits
    await recordEstimatorLearningEvent(id).catch(err =>
      console.error('[estimator:learning] failed to record event', err)
    )

    return NextResponse.json({ estimateId: id, estimateNumber, status: updated.status })
  } catch (err) {
    console.error('[estimator] POST /estimates/[id]/approve', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
