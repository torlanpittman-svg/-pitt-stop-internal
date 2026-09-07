/**
 * CFO inflow evidence hierarchy + anti-double-count engine (money-IN cash-timing forecast).
 *
 * One economic dollar appears ONCE, at the strongest evidence level it currently earns:
 *   L1 SETTLING       customer paid + settlement identified   (needs QB Payments scope → usually $0 now)
 *   L2 RECEIVABLE dated   open QB invoice + defensible cash date (Sterling Tue→Fri owner rule)
 *   L2b RECEIVABLE amount-only  open QB invoice, cash date NOT defensible (shown separately)
 *   L3 EARNED uninvoiced  completed work with a PROVABLE price, not yet invoiced (dealer excluded — unpriced)
 *   L5 BASELINE       historical run-rate for FUTURE activity not already represented above
 *
 * ANTI-DOUBLE-COUNT: specific DATED evidence SUPPRESSES the SAME week's baseline (it does not stack).
 * Undated receivables (L2b) never suppress a dated baseline week. residualBaseline is floored at 0.
 * Pure core (computeInflowForecast) is unit-tested without a DB.
 */
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { finExpectedInflows } from './schema'
import { getArSnapshot } from './ar'
import { sterlingExpectedFriday } from './qb-cfo'

const iso = (d: Date) => d.toISOString().slice(0, 10)
/** Monday-of-week key (stable, unambiguous grouping). */
export function weekKey(dateIso: string): string {
  const d = new Date(dateIso + 'T00:00:00Z'); const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return monday.toISOString().slice(0, 10)
}

export interface DatedInflow { date: string; cents: number; label: string; level: 'L1' | 'L2' }
export interface BaselineInflow { date: string; cents: number }
export interface InflowForecast {
  horizonDays: number
  verifiedSettlingCents: number       // L1
  specificDatedCents: number          // L1 + L2 within horizon
  baselineResidualCents: number       // L5 residual after suppression (floored at 0)
  expectedTotalCents: number          // specificDated + baselineResidual (never double-counted)
  amountKnownDateUnknownCents: number // L2b (NOT in expectedTotal, does NOT suppress baseline)
  earnedUninvoicedCents: number       // L3 (provably priced, no invoice — cash date unknown)
  datedItems: DatedInflow[]
  weeks: { week: string; baselineGrossCents: number; specificCents: number; residualCents: number }[]
}

/**
 * PURE anti-double-count assembly. residualBaseline[week] = max(0, baselineGross[week] − specificDated[week]).
 * expectedTotal = Σ specificDated + Σ residualBaseline. Undated + earned are carried separately.
 */
export function computeInflowForecast(input: {
  horizonDays: number
  dated: DatedInflow[]            // L1/L2 dated within horizon
  baseline: BaselineInflow[]      // L5 derived rows within horizon
  amountKnownDateUnknownCents: number  // L2b
  earnedUninvoicedCents: number        // L3
}): InflowForecast {
  const byWeek = new Map<string, { baseline: number; specific: number }>()
  for (const b of input.baseline) { const k = weekKey(b.date); const w = byWeek.get(k) ?? { baseline: 0, specific: 0 }; w.baseline += b.cents; byWeek.set(k, w) }
  for (const s of input.dated) { const k = weekKey(s.date); const w = byWeek.get(k) ?? { baseline: 0, specific: 0 }; w.specific += s.cents; byWeek.set(k, w) }
  const weeks = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, v]) => ({
    week, baselineGrossCents: v.baseline, specificCents: v.specific, residualCents: Math.max(0, v.baseline - v.specific),
  }))
  const specificDatedCents = input.dated.reduce((t, x) => t + x.cents, 0)
  const baselineResidualCents = weeks.reduce((t, w) => t + w.residualCents, 0)
  const verifiedSettlingCents = input.dated.filter((d) => d.level === 'L1').reduce((t, x) => t + x.cents, 0)
  return {
    horizonDays: input.horizonDays,
    verifiedSettlingCents,
    specificDatedCents,
    baselineResidualCents,
    expectedTotalCents: specificDatedCents + baselineResidualCents,
    amountKnownDateUnknownCents: input.amountKnownDateUnknownCents,
    earnedUninvoicedCents: input.earnedUninvoicedCents,
    datedItems: input.dated.slice().sort((a, b) => a.date.localeCompare(b.date)),
    weeks,
  }
}

/** DB-backed forecast for a horizon. Combines real A/R (Sterling dated / others undated), priced
 *  ready-retail earned work, and the cleaned historical baseline — then applies anti-double-count. */
export async function getInflowForecast(days = 7): Promise<InflowForecast> {
  const db = getDb()
  const today = new Date()
  const end = iso(new Date(Date.now() + days * 86400_000))
  const ar = await getArSnapshot()

  // L2 dated: Sterling invoices with a defensible Tuesday→Friday cash date within the horizon.
  const dated: DatedInflow[] = []
  let datedSum = 0
  for (const inv of ar.invoices) {
    const isSterling = inv.classification === 'dealer' && /sterling/i.test(inv.dealerName ?? '')
    const fri = isSterling ? sterlingExpectedFriday(inv.txnDate, today) : null
    if (fri && fri <= end) { dated.push({ date: fri, cents: inv.balanceCents, label: `${inv.dealerName} #${inv.docNumber ?? inv.qbInvoiceId}`, level: 'L2' }); datedSum += inv.balanceCents }
  }
  // L2b: every other open receivable — amount known, cash date NOT defensible.
  const amountKnownDateUnknownCents = Math.max(0, ar.totalCents - datedSum)

  // L3 earned-but-uninvoiced: ready retail jobs with a PROVABLE agreed price and no QB invoice yet.
  const l3 = await db.execute(sql`
    select coalesce(sum(je.agreed_price_cents),0)::bigint c
    from job_estimates je join service_orders so on so.id = je.service_order_id
    where so.cancelled_at is null and so.delivered_at is null and so.status = 'ready'
      and coalesce(so.service_type,'') <> 'dealer_detail'
      and je.qb_invoice_id is null and je.agreed_price_cents is not null`)
  const earnedUninvoicedCents = Number((l3.rows as any[])[0]?.c ?? 0)

  // L5 baseline: cleaned derived run-rate rows within the horizon.
  const baseRows = await db.select({ date: finExpectedInflows.expectedDate, cents: finExpectedInflows.amountCents })
    .from(finExpectedInflows)
    .where(and(eq(finExpectedInflows.derived, true), sql`${finExpectedInflows.status} <> 'dismissed'`, sql`${finExpectedInflows.expectedDate} <= ${end}`))
  const baseline: BaselineInflow[] = baseRows.map((r) => ({ date: r.date, cents: r.cents }))

  return computeInflowForecast({ horizonDays: days, dated, baseline, amountKnownDateUnknownCents, earnedUninvoicedCents })
}
