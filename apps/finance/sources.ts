/**
 * CFO source / freshness / confidence model. Every money value the Command Center shows is
 * wrapped so a QuickBooks BOOK balance is never presented as live cash.
 */
export type FinSource = 'qbo' | 'plaid' | 'manual' | 'document'
export type FinConfidence = 'book' | 'live' | 'estimated' | 'manual_verified' | 'forecast'

export interface MoneyValue {
  cents: number
  source: FinSource
  asOf: string          // ISO
  confidence: FinConfidence
  stale: boolean
  /** True only for values we'd trust as spendable cash (live bank or a verified manual figure). */
  trusted: boolean
}

const STALE_HOURS = 24

export function isStale(asOf: string | Date | null | undefined, hours = STALE_HOURS): boolean {
  if (!asOf) return true
  const t = (asOf instanceof Date ? asOf : new Date(asOf)).getTime()
  return Number.isNaN(t) || Date.now() - t > hours * 3600_000
}

export function money(cents: number, source: FinSource, asOf: string | Date, confidence: FinConfidence): MoneyValue {
  const iso = asOf instanceof Date ? asOf.toISOString() : asOf
  return {
    cents,
    source,
    asOf: iso,
    confidence,
    stale: isStale(iso),
    trusted: confidence === 'live' || confidence === 'manual_verified',
  }
}

/** Human freshness label, e.g. "12 min ago" / "3 days ago". */
export function freshnessLabel(asOf: string | Date | null | undefined): string {
  if (!asOf) return 'never'
  const t = (asOf instanceof Date ? asOf : new Date(asOf)).getTime()
  if (Number.isNaN(t)) return 'unknown'
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 90) return `${s}s ago`
  const m = Math.floor(s / 60); if (m < 90) return `${m} min ago`
  const h = Math.floor(m / 60); if (h < 36) return `${h}h ago`
  return `${Math.floor(h / 24)} days ago`
}
