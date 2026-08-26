/**
 * Plaid client — READ-ONLY. Raw fetch (no SDK). Used only to: create a Link token, exchange a
 * public token for an access token, read institution metadata, and read account balances.
 * There is NO transfer / payment / auth-numbers usage here — this module cannot move money.
 * Access tokens are handled server-side only and stored ENCRYPTED by the caller.
 */
const APP = 'finance:plaid'

export type PlaidEnv = 'sandbox' | 'production'
export function plaidEnv(): PlaidEnv { return process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox' }
const BASE: Record<PlaidEnv, string> = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' }

export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)
}
export function plaidDiagnostics() {
  return {
    clientId: Boolean(process.env.PLAID_CLIENT_ID),
    secret: Boolean(process.env.PLAID_SECRET),
    env: plaidEnv(),
    redirectUri: process.env.PLAID_REDIRECT_URI ?? null,
  }
}
function creds() {
  const client_id = process.env.PLAID_CLIENT_ID, secret = process.env.PLAID_SECRET
  if (!client_id || !secret) throw new Error('Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET).')
  return { client_id, secret }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE[plaidEnv()]}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...creds(), ...body }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error_code) {
    const msg = `${json.error_code ?? res.status}: ${json.error_message ?? 'Plaid request failed'}`
    throw new Error(`${APP} ${path} → ${msg}`)
  }
  return json as T
}

/** Create a Link token for the read-only connect. Requests the `transactions` product (which
 *  includes balance access) so the same connection serves the next slice without re-auth. */
export async function createLinkToken(clientUserId: string): Promise<string> {
  const redirect = process.env.PLAID_REDIRECT_URI
  const r = await call<{ link_token: string }>('/link/token/create', {
    user: { client_user_id: clientUserId },
    client_name: 'Pitt Stop OS — Financial Command Center',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
    ...(redirect ? { redirect_uri: redirect } : {}),
  })
  return r.link_token
}

export async function exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
  const r = await call<{ access_token: string; item_id: string }>('/item/public_token/exchange', { public_token: publicToken })
  return { accessToken: r.access_token, itemId: r.item_id }
}

export async function getItemInstitution(accessToken: string): Promise<{ institutionId: string | null; name: string | null }> {
  const item = await call<{ item: { institution_id?: string } }>('/item/get', { access_token: accessToken })
  const institutionId = item.item?.institution_id ?? null
  if (!institutionId) return { institutionId: null, name: null }
  const inst = await call<{ institution: { name?: string } }>('/institutions/get_by_id', { institution_id: institutionId, country_codes: ['US'] })
  return { institutionId, name: inst.institution?.name ?? null }
}

export interface PlaidAccountBalance {
  plaidAccountId: string
  name: string | null
  officialName: string | null
  mask: string | null
  type: string | null
  subtype: string | null
  currentCents: number | null
  availableCents: number | null
  currency: string | null
  raw: unknown
}
const toCents = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100))

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PlaidTxn {
  transaction_id: string
  account_id: string
  pending_transaction_id: string | null
  amount: number
  iso_currency_code: string | null
  date: string
  authorized_date: string | null
  pending: boolean
  name: string | null
  merchant_name: string | null
  payment_channel: string | null
  personal_finance_category: { primary?: string; detailed?: string; confidence_level?: string } | null
  category: string[] | null
  payment_meta?: any
  transaction_type?: string | null
  [k: string]: any
}
export interface TxnSyncPage { added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transaction_id: string }[]; nextCursor: string | null; hasMore: boolean }

/** One page of Plaid /transactions/sync. Read-only. Cursor drives incremental, exactly-once sync;
 *  Plaid returns pending → posted transitions as modified rows (same account, new transaction_id
 *  with pending_transaction_id linking back). */
export async function transactionsSync(accessToken: string, cursor: string | null): Promise<TxnSyncPage> {
  const r = await call<any>('/transactions/sync', {
    access_token: accessToken,
    ...(cursor ? { cursor } : {}),
    count: 500,
    options: { include_personal_finance_category: true },
  })
  return { added: r.added ?? [], modified: r.modified ?? [], removed: r.removed ?? [], nextCursor: r.next_cursor ?? null, hasMore: Boolean(r.has_more) }
}

/** Read-only real-time balances for every account on the Item. */
export async function getAccountBalances(accessToken: string): Promise<PlaidAccountBalance[]> {
  const r = await call<{ accounts: any[] }>('/accounts/balance/get', { access_token: accessToken })
  return (r.accounts ?? []).map((a) => ({
    plaidAccountId: a.account_id,
    name: a.name ?? null,
    officialName: a.official_name ?? null,
    mask: a.mask ?? null,
    type: a.type ?? null,
    subtype: a.subtype ?? null,
    currentCents: toCents(a.balances?.current),
    availableCents: toCents(a.balances?.available),
    currency: a.balances?.iso_currency_code ?? null,
    raw: a,
  }))
}
