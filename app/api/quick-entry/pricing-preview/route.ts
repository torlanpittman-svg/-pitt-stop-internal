/**
 * POST /api/quick-entry/pricing-preview  { workPriceCents }
 * Manager/admin-only. Returns the explicit_pretax breakdown (shop supplies, card fee,
 * tax, total) for an entered work price using the SAME pure engine as recomputeEstimate
 * (explicitPretaxTotals) — so the review preview can never drift from the stored result.
 * Read-only: no estimate is created or written.
 */
import { NextResponse } from 'next/server'
import { getActor } from '@/apps/workflow/identity'
import { getBusinessConfig } from '@/apps/settings/db'
import { explicitPretaxTotals } from '@/apps/workflow/fees'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const actor = getActor(req.headers.get('cookie'))
  if (!actor || (actor.role !== 'manager' && actor.role !== 'admin')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({})) as { workPriceCents?: number }
  const cents = Math.max(0, Math.round(Number(body.workPriceCents) || 0))
  const cfg = await getBusinessConfig()
  const t = explicitPretaxTotals(cents, cfg, cfg.defaultTaxBps, 'review')
  return NextResponse.json({
    workPriceCents:    t.workPriceCents,
    shopSuppliesCents: t.shopSuppliesCents,
    cardFeeCents:      t.cardFeeCents,
    cardFeeEnabled:    cfg.cardFeeEnabled,
    taxCents:          t.taxCents,
    needsTaxReview:    t.needsTaxReview,
    totalCents:        t.totalCents,
  })
}
