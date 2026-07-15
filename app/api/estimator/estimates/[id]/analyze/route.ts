import { NextResponse } from 'next/server'
import { getEstimate, updateEstimate, createEstimateLineItem } from '@/apps/estimator/db'

export const dynamic = 'force-dynamic'

// Placeholder line items by service focus.
// Milestone 2 replaces this with real AI vision analysis.
function placeholderLineItems(serviceFocus: string | null) {
  const focus = serviceFocus ?? 'full_detail'

  const byFocus: Record<string, Array<{
    description: string
    serviceCode: string
    laborMinutes: number
    unitPriceCents: number
  }>> = {
    full_detail: [
      { description: 'Full Interior Detail — vacuum, shampoo seats and carpet, wipe all surfaces', serviceCode: 'interior_full', laborMinutes: 90, unitPriceCents: 14000 },
      { description: 'Exterior Wash, Clay Bar, and Polish', serviceCode: 'exterior_polish', laborMinutes: 75, unitPriceCents: 12000 },
      { description: 'Wheel and Tire Cleaning', serviceCode: 'wheels_clean', laborMinutes: 30, unitPriceCents: 4000 },
      { description: 'Glass Cleaning — interior and exterior', serviceCode: 'glass_clean', laborMinutes: 20, unitPriceCents: 2500 },
    ],
    exterior_only: [
      { description: 'Exterior Hand Wash and Dry', serviceCode: 'exterior_wash', laborMinutes: 45, unitPriceCents: 6000 },
      { description: 'Exterior Polish and Wax', serviceCode: 'exterior_polish', laborMinutes: 60, unitPriceCents: 9500 },
      { description: 'Wheel and Tire Cleaning', serviceCode: 'wheels_clean', laborMinutes: 30, unitPriceCents: 4000 },
    ],
    interior_only: [
      { description: 'Full Interior Vacuum — seats, carpet, cargo area', serviceCode: 'interior_vacuum', laborMinutes: 40, unitPriceCents: 5500 },
      { description: 'Seat and Carpet Shampoo', serviceCode: 'interior_shampoo', laborMinutes: 60, unitPriceCents: 10000 },
      { description: 'Dashboard, Console, and Door Panel Wipe-Down', serviceCode: 'interior_surfaces', laborMinutes: 25, unitPriceCents: 3500 },
      { description: 'Interior Glass Cleaning', serviceCode: 'glass_interior', laborMinutes: 15, unitPriceCents: 2000 },
    ],
    specific_service: [
      { description: 'Custom Service — details to be specified', serviceCode: 'custom', laborMinutes: 60, unitPriceCents: 9500 },
    ],
  }

  return byFocus[focus] ?? byFocus.full_detail
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const estimate = await getEstimate(id)
    if (!estimate) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    await updateEstimate(id, { status: 'ai_pending' })

    // Simulate analysis delay (real AI will take ~12s; placeholder takes <1ms)
    const items = placeholderLineItems(estimate.serviceFocus)

    let totalLaborMinutes = 0
    let totalPriceCents = 0

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      await createEstimateLineItem({
        estimateId:     id,
        displayOrder:   i,
        description:    item.description,
        serviceCode:    item.serviceCode,
        laborMinutes:   item.laborMinutes,
        unitPriceCents: item.unitPriceCents,
        lineTotalCents: item.unitPriceCents,
        included:       true,
      })
      totalLaborMinutes += item.laborMinutes
      totalPriceCents   += item.unitPriceCents
    }

    await updateEstimate(id, {
      status:                'needs_review',
      promptVersion:         'placeholder-v1',
      modelName:             'placeholder',
      aiTotalLaborMinutes:   totalLaborMinutes,
      recommendedPriceCents: totalPriceCents,
    })

    return NextResponse.json({ estimateId: id, status: 'needs_review' })
  } catch (err) {
    console.error('[estimator] POST /estimates/[id]/analyze', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
