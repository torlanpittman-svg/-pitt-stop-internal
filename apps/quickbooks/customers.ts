/**
 * QuickBooks customer read + upsert helpers.
 *
 * Reads are always safe. `ensureCustomer` creates a customer only if one with
 * the exact DisplayName does not already exist — used to set up dealer records.
 * In production this only runs after the owner has approved the mapping.
 */
import { queryQBO, qbApiRequest, qboEscape } from './client'
import { logger } from '@/platform/logger'

// ── Email reconciliation (shared policy) ─────────────────────────────────────
// Used to reliably propagate a configured billing email onto a QB customer without
// clobbering a different one. Retail has its own copy; this serves the dealer fix.
export type EmailReconcileStatus = 'match' | 'filled_blank' | 'conflict' | 'no_desired' | 'error'
export interface EmailDecision { billEmail: string | null; status: EmailReconcileStatus; conflict: boolean; fill: boolean }

/** PURE decision: given the QB customer's current email and the desired (configured) email:
 *  blank → fill; equal → reuse; different → flag conflict (do NOT overwrite); none → leave. */
export function decideEmailReconcile(existingEmail: string | null | undefined, desiredEmail: string | null | undefined): EmailDecision {
  const desired = (desiredEmail ?? '').trim() || null
  const existing = (existingEmail ?? '').trim() || null
  if (!desired) return { billEmail: existing, status: 'no_desired', conflict: false, fill: false }
  if (!existing) return { billEmail: desired, status: 'filled_blank', conflict: false, fill: true }
  if (existing.toLowerCase() === desired.toLowerCase()) return { billEmail: desired, status: 'match', conflict: false, fill: false }
  return { billEmail: desired, status: 'conflict', conflict: true, fill: false }   // invoice uses configured; customer left as-is
}

export interface EmailReconcileResult { billEmail: string | null; status: EmailReconcileStatus; conflict: boolean }

/** Ensure a QB customer carries the desired email (fill only when blank), per the policy.
 *  Never overwrites a different existing email. Returns the email to use for BillEmail. */
export async function reconcileCustomerEmail(customerId: string, desiredEmail: string | null | undefined): Promise<EmailReconcileResult> {
  const desired = (desiredEmail ?? '').trim() || null
  if (!desired) return { billEmail: null, status: 'no_desired', conflict: false }
  try {
    const res = await queryQBO<{ Customer?: Array<{ Id: string; SyncToken: string; PrimaryEmailAddr?: { Address?: string } }> }>(
      `SELECT * FROM Customer WHERE Id = '${qboEscape(customerId)}'`,
    )
    const c = res.Customer?.[0]
    if (!c) return { billEmail: desired, status: 'error', conflict: false }
    const d = decideEmailReconcile(c.PrimaryEmailAddr?.Address ?? null, desired)
    if (d.fill) {
      await qbApiRequest({ method: 'POST', path: '/customer', body: { Id: c.Id, SyncToken: c.SyncToken, sparse: true, PrimaryEmailAddr: { Address: desired } } })
      logger.info('quickbooks:customers', 'email.filled_blank', { customerId })
    }
    if (d.conflict) logger.warn('quickbooks:customers', 'email.conflict', { customerId, desired })
    return { billEmail: d.billEmail, status: d.status, conflict: d.conflict }
  } catch (e) {
    logger.warn('quickbooks:customers', 'reconcile_email_failed', { customerId, error: String(e) })
    return { billEmail: desired, status: 'error', conflict: false }
  }
}

export interface QBCustomer {
  id:          string
  displayName: string
  email:       string | null
  active:      boolean
  syncToken:   string
}

interface RawCustomer {
  Id:              string
  DisplayName:     string
  Active?:         boolean
  SyncToken:       string
  PrimaryEmailAddr?: { Address?: string }
}

function mapCustomer(c: RawCustomer): QBCustomer {
  return {
    id:          c.Id,
    displayName: c.DisplayName,
    email:       c.PrimaryEmailAddr?.Address ?? null,
    active:      c.Active ?? true,
    syncToken:   c.SyncToken,
  }
}

/** Exact-match lookup by DisplayName. Returns null if not found. */
export async function findCustomerByName(displayName: string): Promise<QBCustomer | null> {
  const res = await queryQBO<{ Customer?: RawCustomer[] }>(
    `select * from Customer where DisplayName = '${qboEscape(displayName)}'`
  )
  const match = res.Customer?.[0]
  return match ? mapCustomer(match) : null
}

/** Fuzzy lookup (LIKE) — useful for discovering dealer variants. */
export async function searchCustomers(term: string): Promise<QBCustomer[]> {
  const res = await queryQBO<{ Customer?: RawCustomer[] }>(
    `select * from Customer where DisplayName like '%${qboEscape(term)}%'`
  )
  return (res.Customer ?? []).map(mapCustomer)
}

/**
 * Find a customer by exact DisplayName, or create it if missing.
 * Returns the customer plus whether it was newly created.
 */
export async function ensureCustomer(params: {
  displayName: string
  email?:      string
}): Promise<{ customer: QBCustomer; created: boolean }> {
  const existing = await findCustomerByName(params.displayName)
  if (existing) return { customer: existing, created: false }

  const body: Record<string, unknown> = { DisplayName: params.displayName }
  if (params.email) body.PrimaryEmailAddr = { Address: params.email }

  const data = await qbApiRequest<{ Customer: RawCustomer }>({
    method: 'POST',
    path:   '/customer',
    body,
  })
  return { customer: mapCustomer(data.Customer), created: true }
}
