/**
 * POST /api/quickbooks/setup-dealers
 *
 * Idempotent dealer setup: ensures each Sterling dealer exists as a QuickBooks
 * customer, then persists the verified qb_customer_id onto the dealerships table
 * (one row per stock prefix). Naming, prefixes, and billing email are the
 * owner-confirmed business facts from historical Sterling invoices — the QB
 * customer IDs are read live, never hardcoded.
 *
 * Safe on sandbox. On production this creates customers only if missing; run it
 * only after the live company + mapping are approved.
 */
import { NextResponse } from 'next/server'
import { ensureCustomer } from '@/apps/quickbooks/customers'
import { upsertDealershipByPrefix } from '@/apps/vehicle-entry/db'
import { getConnectionStatus } from '@/apps/quickbooks/connection'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BILLING_EMAIL = 'billing@sterlingautogroup.net'

// Dealer business config (owner-confirmed). Stock prefixes map to one QB customer.
const DEALERS: Array<{ qbName: string; prefixes: string[] }> = [
  { qbName: 'Sterling Kia',        prefixes: ['K'] },
  { qbName: 'Sterling Subaru',     prefixes: ['U'] },
  { qbName: 'Sterling Auto Group', prefixes: ['S', 'T'] },
]

export async function POST() {
  const status = await getConnectionStatus()
  if (!status.connected) {
    return NextResponse.json({ ok: false, error: 'QuickBooks is not connected.' }, { status: 409 })
  }

  const results: unknown[] = []
  try {
    for (const dealer of DEALERS) {
      const { customer, created } = await ensureCustomer({ displayName: dealer.qbName, email: BILLING_EMAIL })
      const rows = []
      for (const prefix of dealer.prefixes) {
        const row = await upsertDealershipByPrefix({
          name:           dealer.qbName,
          stockPrefix:    prefix,
          qbCustomerId:   customer.id,
          qbCustomerName: customer.displayName,
          billingEmail:   BILLING_EMAIL,
          taxExempt:      true,
          rateDefault:    200,
        })
        rows.push({ prefix, dealershipId: row.id })
      }
      results.push({
        dealer:         dealer.qbName,
        qbCustomerId:   customer.id,
        qbCustomerCreated: created,
        prefixes:       rows,
      })
      logger.info('quickbooks:setup-dealers', 'dealer.ready', { dealer: dealer.qbName, qbCustomerId: customer.id, created })
    }
    return NextResponse.json({ ok: true, environment: status.environment, dealers: results })
  } catch (err) {
    logger.error('quickbooks:setup-dealers', 'failed', { error: String(err) })
    return NextResponse.json({ ok: false, error: String(err), partial: results }, { status: 500 })
  }
}
