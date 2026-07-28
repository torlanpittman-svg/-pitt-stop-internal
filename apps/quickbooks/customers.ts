/**
 * QuickBooks customer read + upsert helpers.
 *
 * Reads are always safe. `ensureCustomer` creates a customer only if one with
 * the exact DisplayName does not already exist — used to set up dealer records.
 * In production this only runs after the owner has approved the mapping.
 */
import { queryQBO, qbApiRequest, qboEscape } from './client'

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
