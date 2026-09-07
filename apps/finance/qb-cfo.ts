/**
 * CFO ↔ QuickBooks truth guards + pure receivable helpers. Owner-confirmed: the ONLY authoritative
 * Pitt Stop accounting company is the PRODUCTION realm below. The sandbox realm holds QuickBooks
 * sample-company data and must NEVER become CFO production truth — so we fail closed: A/R detail is
 * persisted only for the production realm, and every read filters to it.
 *
 * All functions here are PURE (no DB, no network) so the env-safety, aging, classification and the
 * owner-confirmed Sterling Tuesday→Friday rule are unit-tested without production access.
 */

// Owner-confirmed authoritative company (do not change without owner confirmation).
export const CFO_PRODUCTION_REALM = '123146329198289'
export const CFO_SANDBOX_REALM = '9341457607058056'

export interface CfoRealmDecision { ok: boolean; realmId: string; environment: string; reason: string }

/** Fail-closed gate: A/R may be persisted as CFO truth ONLY from the production realm + environment.
 *  Anything else (sandbox, wrong realm, missing) is rejected and logged by the caller. */
export function assertCfoProductionRealm(realmId: string | null | undefined, environment: string | null | undefined): CfoRealmDecision {
  const r = realmId ?? '', e = environment ?? ''
  if (e !== 'production') return { ok: false, realmId: r, environment: e, reason: `environment is '${e || 'unset'}', not production` }
  if (r !== CFO_PRODUCTION_REALM) return { ok: false, realmId: r, environment: e, reason: `realm '${r || 'unset'}' is not the authoritative production company ${CFO_PRODUCTION_REALM}` }
  return { ok: true, realmId: r, environment: e, reason: 'authoritative production company' }
}

// ── A/R aging ────────────────────────────────────────────────────────────────
export type AgingBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+'
/** Aging from the due date (falls back to txn date). ageDays = days past due (negative = not yet due). */
export function agingOf(dueOrTxn: string | null, asOf: Date): { bucket: AgingBucket; ageDays: number } {
  if (!dueOrTxn) return { bucket: 'current', ageDays: 0 }
  const due = new Date(dueOrTxn + 'T00:00:00Z').getTime()
  const asOfUTC = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate())
  const ageDays = Math.round((asOfUTC - due) / 86400_000)
  const bucket: AgingBucket = ageDays <= 0 ? 'current' : ageDays <= 30 ? '1-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '90+'
  return { bucket, ageDays }
}

// ── Dealer / retail / unknown classification (defensible mapping only) ─────────
export interface ReceivableClass { classification: 'dealer' | 'retail' | 'unknown'; dealerName: string | null; linkedEstimateId: string | null }
/**
 * Classify a QB invoice using AUTHORITATIVE mappings only:
 *  - dealer  → the invoice's QB customerId is in the dealerships QB-customer map.
 *  - retail  → the invoice id links to a Pitt Stop retail estimate (job_estimates.qb_invoice_id).
 *  - unknown → neither (never guessed from a name that merely "sounds like" a dealer).
 */
export function classifyReceivable(
  invoice: { qbInvoiceId: string; customerId: string | null },
  dealerByCustomerId: Map<string, string>,
  estimateIdByInvoiceId: Map<string, string>,
): ReceivableClass {
  const dealerName = invoice.customerId ? dealerByCustomerId.get(invoice.customerId) ?? null : null
  if (dealerName) return { classification: 'dealer', dealerName, linkedEstimateId: null }
  const est = estimateIdByInvoiceId.get(invoice.qbInvoiceId) ?? null
  if (est) return { classification: 'retail', dealerName: null, linkedEstimateId: est }
  return { classification: 'unknown', dealerName: null, linkedEstimateId: null }
}

// ── Owner-confirmed Sterling Tuesday→Friday payment cycle ──────────────────────
const iso = (d: Date) => d.toISOString().slice(0, 10)
/** The Friday of the submission cycle a Sterling invoice belongs to (its week's Tuesday + 3 days). */
function cycleFridayFor(txnDate: string): Date {
  const d = new Date(txnDate + 'T00:00:00Z')
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) // Monday of the invoice's week
  const fri = new Date(monday); fri.setUTCDate(monday.getUTCDate() + 4)                     // Mon + 4 = Friday
  return fri
}
/**
 * Owner-confirmed rule: Sterling work → invoice submitted Tuesday → Sterling check on FRIDAY of that
 * week. Assign the cycle Friday ONLY when it is defensible: the Friday is not in the past and is within
 * the near window (the invoice plausibly belongs to the CURRENT pay cycle). Otherwise return null —
 * the amount is known but the cash date is NOT (an overdue/ambiguous invoice, shown as date-unknown).
 */
export function sterlingExpectedFriday(txnDate: string | null, today: Date, windowDays = 10): string | null {
  if (!txnDate) return null
  const fri = cycleFridayFor(txnDate)
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const days = Math.round((fri.getTime() - todayUTC) / 86400_000)
  if (days < 0) return null            // that Friday already passed → not defensibly this cycle
  if (days > windowDays) return null   // too far out to attribute to the current cycle
  return iso(fri)
}
