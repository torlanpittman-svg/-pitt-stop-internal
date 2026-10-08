/**
 * MarketingRecommendationEngine — deterministic, explainable recommendations over Google Ads data.
 * All revenue/ROAS here is GOOGLE-ADS-REPORTED (what the platform reports / the owner imported), NOT
 * Pitt Stop collected cash and NOT profit — shop costs aren't included, so "ROAS" is a reported
 * revenue-to-spend ratio, a directional signal only. Everything here is a RECOMMENDATION; nothing
 * changes a budget or keyword automatically. Rules are pure + testable (no AI), so the owner always
 * sees the number and the reason behind each suggestion.
 */
import { SERVICE_CATEGORY_LABELS } from './types'
import type { CategoryAdRollup } from './ads'
import type { SearchTerm } from './ads'

export type RecommendationType = 'budget_shift' | 'underperformer' | 'negative_keyword' | 'opportunity'
export interface Recommendation {
  id: string
  type: RecommendationType
  severity: 'info' | 'warn'
  title: string
  detail: string
  action: string
}

function roas(revenueCents: number, spendCents: number): number | null {
  return spendCents > 0 ? revenueCents / spendCents : null
}
function dollars(cents: number): string { return `$${Math.round(cents / 100).toLocaleString('en-US')}` }
function label(cat: string): string { return SERVICE_CATEGORY_LABELS[cat as keyof typeof SERVICE_CATEGORY_LABELS] ?? cat }

// Search-term tokens that usually signal non-customer / DIY / job-seeker intent.
const BAD_INTENT = [/\bdiy\b/i, /\bwalmart\b/i, /\bamazon\b/i, /\bjobs?\b/i, /\bsalary\b/i, /\bhiring\b/i, /\btraining\b/i, /\bhow\s+to\b/i, /\bfree\b/i, /\bproduct\b/i, /\bkit\b/i, /\bnear\s+me\s+cheap\b/i]

export interface AdRecommendationInput {
  byCategory: CategoryAdRollup[]
  searchTerms: SearchTerm[]
  /** Minimum spend (cents) before a category/term is considered material. */
  minSpendCents?: number
}

export function buildAdRecommendations(input: AdRecommendationInput): Recommendation[] {
  const minSpend = input.minSpendCents ?? 5_000 // $50
  const recs: Recommendation[] = []
  const cats = input.byCategory.filter((c) => c.spendCents >= minSpend)

  // 1. Budget shift: best vs worst performer when the gap is real.
  const scored = cats
    .map((c) => ({ c, r: roas(c.revenueCents, c.spendCents) }))
    .filter((x) => x.r != null) as Array<{ c: CategoryAdRollup; r: number }>
  if (scored.length >= 2) {
    scored.sort((a, b) => b.r - a.r)
    const best = scored[0], worst = scored[scored.length - 1]
    if (best.r >= 2 && best.r >= worst.r * 2 && worst.c.serviceCategory !== best.c.serviceCategory) {
      recs.push({
        id: `budget_shift:${worst.c.serviceCategory}->${best.c.serviceCategory}`,
        type: 'budget_shift', severity: 'info',
        title: `Shift budget toward ${label(best.c.serviceCategory)}`,
        detail: `${label(worst.c.serviceCategory)} spent ${dollars(worst.c.spendCents)} and reported ${dollars(worst.c.revenueCents)} (${worst.r.toFixed(1)}x), while ${label(best.c.serviceCategory)} spent ${dollars(best.c.spendCents)} and reported ${dollars(best.c.revenueCents)} (${best.r.toFixed(1)}x). Figures are Google-Ads-reported, not profit.`,
        action: `Consider moving budget from ${label(worst.c.serviceCategory)} to ${label(best.c.serviceCategory)}.`,
      })
    }
  }

  // 2. Underperformers: material spend with no/weak return.
  for (const c of cats) {
    const r = roas(c.revenueCents, c.spendCents)
    if (c.revenueCents === 0) {
      recs.push({
        id: `underperformer:${c.serviceCategory}`, type: 'underperformer', severity: 'warn',
        title: `${label(c.serviceCategory)} has spend but no reported revenue`,
        detail: `${label(c.serviceCategory)} spent ${dollars(c.spendCents)} across ${c.clicks} clicks with ${c.conversions} conversions and $0 Google-Ads-reported revenue in this period.`,
        action: 'Review landing page, call tracking, and whether jobs are being attributed back — or pause until fixed.',
      })
    } else if (r != null && r < 1) {
      recs.push({
        id: `underperformer:${c.serviceCategory}`, type: 'underperformer', severity: 'warn',
        title: `${label(c.serviceCategory)}: reported revenue is below ad spend`,
        detail: `${label(c.serviceCategory)} spent ${dollars(c.spendCents)} and reported ${dollars(c.revenueCents)} (${r.toFixed(1)}x reported revenue vs spend — not profit).`,
        action: 'Tighten keywords/audience or reduce budget until the reported return improves.',
      })
    }
  }

  // 3. Negative keywords: spend, no conversions, non-customer intent.
  for (const t of input.searchTerms) {
    if (t.spendCents < minSpend || t.conversions > 0) continue
    const bad = BAD_INTENT.find((re) => re.test(t.term))
    if (!bad) continue
    recs.push({
      id: `negative_keyword:${t.term.toLowerCase()}`, type: 'negative_keyword', severity: 'warn',
      title: `Add "${t.term}" as a negative keyword`,
      detail: `Search term "${t.term}" spent ${dollars(t.spendCents)} across ${t.clicks} clicks with 0 conversions and reads as non-customer/DIY intent.`,
      action: `Review and add "${t.term}" as a negative keyword (confirm it isn't a valid customer phrase first).`,
    })
  }

  return recs
}
