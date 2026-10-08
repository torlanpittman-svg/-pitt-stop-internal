import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { marketingReport, weekStart } from './report'
import { attributedCompletedJobs, recordAttribution, linkRecipientOutcome, linkLeadOutcome } from './attribution'
import { upsertAdMetric } from './ads'
import { createLead } from './leads'
import { createCampaign, insertRecipients, listRecipients } from './db'

const pg = new PGlite()

// service_orders + job_estimates mirror the canonical columns the report reads. qb_invoice_id is the
// INVOICE ANCHOR — invoiced revenue is only recognized when it is present; otherwise the completed job
// has a known quoted value but UNKNOWN invoiced value. cancelled_at proves cancelled jobs never count.
const PARENTS = `
  CREATE TABLE customers (id uuid PRIMARY KEY, display_name text, first_name text, last_name text, phone text, email text, active boolean NOT NULL DEFAULT true);
  CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, customer_name text, status text,
    completed_at timestamptz, cancelled_at timestamptz, created_at timestamptz, approved_price_cents integer, services jsonb);
  CREATE TABLE order_photos (id uuid PRIMARY KEY);
  CREATE TABLE job_estimates (id uuid PRIMARY KEY, service_order_id uuid, total_cents integer, qb_invoice_id text);
`
const RANGE = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-07T23:59:59Z') }
const inRange = new Date('2026-10-04T00:00:00Z')

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0047_marketing_sms_consent.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0048_marketing_sms_delivery.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec(`DELETE FROM marketing_ad_metrics; DELETE FROM marketing_attribution; DELETE FROM marketing_leads;
    DELETE FROM marketing_events; DELETE FROM marketing_campaign_recipients; DELETE FROM marketing_campaigns;
    DELETE FROM job_estimates; DELETE FROM service_orders; DELETE FROM customers;`)
})

/** Insert a service order + optional estimate. `qbInvoiceId` set ⇒ invoiced; else quoted-only. */
async function order(opts: {
  status?: string; completedAt?: Date | null; cancelledAt?: Date | null
  totalCents?: number | null; approvedCents?: number | null; qbInvoiceId?: string | null; services?: string[] | null
}): Promise<string> {
  const id = randomUUID()
  await pg.query(
    'INSERT INTO service_orders (id, status, completed_at, cancelled_at, created_at, approved_price_cents, services) VALUES ($1,$2,$3,$4,now(),$5,$6)',
    [id, opts.status ?? 'ready', opts.completedAt ?? null, opts.cancelledAt ?? null, opts.approvedCents ?? null, opts.services ? JSON.stringify(opts.services) : null],
  )
  if (opts.totalCents != null || opts.qbInvoiceId != null) {
    await pg.query('INSERT INTO job_estimates (id, service_order_id, total_cents, qb_invoice_id) VALUES ($1,$2,$3,$4)',
      [randomUUID(), id, opts.totalCents ?? 0, opts.qbInvoiceId ?? null])
  }
  return id
}
const attr = (serviceOrderId: string, over: Partial<Parameters<typeof recordAttribution>[0]> = {}) =>
  recordAttribution({ source: 'sms', confidence: 'direct', serviceOrderId, occurredAt: inRange, ...over }, 'a')

describe('weekly report — honest empty state', () => {
  it('renders all zeros with no invented analytics', async () => {
    const r = await marketingReport(RANGE)
    expect(r.isEmpty).toBe(true)
    expect(r.spendCents).toBe(0)
    expect(r.invoicedRevenueCents).toBe(0)
    expect(r.quotedJobValueCents).toBe(0)
    expect(r.collectedRevenueCents).toBeNull()
    expect(r.completedJobs).toBe(0)
    expect(r.jobsInvoiced).toBe(0)
    expect(r.roas).toBeNull()
    expect(r.leads).toBe(0)
    expect(r.byChannel).toEqual([])
  })
})

describe('weekly report — canonical completed revenue', () => {
  it('counts invoiced revenue only on a QB anchor; quoted value is separate; ad data stays separate', async () => {
    await upsertAdMetric({ serviceCategory: 'ceramic', statDate: '2026-10-03', spendCents: 41000, clicks: 50, conversions: 3, revenueCents: 430000 }, 'admin')
    await upsertAdMetric({ serviceCategory: 'general', statDate: '2026-10-03', spendCents: 39000, clicks: 80, conversions: 1, revenueCents: 55000 }, 'admin')

    const invoiced = await order({ completedAt: inRange, totalCents: 224000, qbInvoiceId: 'INV-1', services: ['Ceramic Coating'] })
    const quotedOnly = await order({ completedAt: inRange, totalCents: 100000, services: ['Interior detail'] }) // no qb anchor
    await attr(invoiced, { source: 'sms', confidence: 'direct' })
    await attr(quotedOnly, { source: 'sms', confidence: 'direct' })
    await createLead({ source: 'google_ads', name: 'Lead A', createdAt: inRange }, 'admin')
    await createLead({ source: 'facebook_organic', name: 'Lead B', createdAt: inRange }, 'admin')

    const r = await marketingReport(RANGE)
    expect(r.isEmpty).toBe(false)
    expect(r.spendCents).toBe(80000)
    expect(r.adReportedRevenueCents).toBe(485000)
    expect(r.adReportedConversions).toBe(4)
    expect(r.invoicedRevenueCents).toBe(224000)        // only the QB-anchored order
    expect(r.quotedJobValueCents).toBe(324000)         // both completed jobs' estimated value
    expect(r.completedJobs).toBe(2)
    expect(r.jobsInvoiced).toBe(1)
    expect(r.roas).toBeCloseTo(2.8, 1)                 // invoiced 224000 / 80000
    expect(r.leads).toBe(2)

    const sms = r.bySource.find((s) => s.source === 'sms')!
    expect(sms.revenueCents).toBe(224000)              // invoiced only
    expect(sms.count).toBe(2)

    const ga = r.byChannel.find((c) => c.channel === 'google_ads')!
    expect(ga.spendCents).toBe(80000)
    expect(ga.leads).toBe(1)

    const ceramic = r.byService.find((s) => s.serviceCategory === 'ceramic')!
    expect(ceramic.invoicedRevenueCents).toBe(224000)
    const interior = r.byService.find((s) => s.serviceCategory === 'interior')!
    expect(interior.invoicedRevenueCents).toBe(0)
    expect(interior.quotedJobValueCents).toBe(100000)
  })

  it('a completed job with no invoice has UNKNOWN invoiced value (null), never zero', async () => {
    const o = await order({ completedAt: inRange, totalCents: 150000 }) // quote present, no qb anchor
    await attr(o)
    const jobs = await attributedCompletedJobs(RANGE)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].invoicedCents).toBeNull()
    expect(jobs[0].quotedValueCents).toBe(150000)
    const r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(0)
    expect(r.jobsInvoiced).toBe(0)
  })

  it('counts a single order ONCE with first + last (and direct + assisted) touches', async () => {
    const o = await order({ completedAt: inRange, totalCents: 100000, qbInvoiceId: 'INV-2' })
    await attr(o, { source: 'sms', confidence: 'assisted', touchType: 'first', revenueCents: 100000 })
    await attr(o, { source: 'sms', confidence: 'direct', touchType: 'last', revenueCents: 100000 })
    const r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(100000) // once, not 200000
    const sms = r.bySource.find((s) => s.source === 'sms')!
    expect(sms.count).toBe(1)
    expect(sms.direct).toBe(1)
    expect(sms.assisted).toBe(0)
  })

  it('excludes incomplete and cancelled jobs', async () => {
    const working = await order({ status: 'in_progress', completedAt: null, totalCents: 70000, qbInvoiceId: 'X' })
    const cancelled = await order({ status: 'cancelled', completedAt: inRange, cancelledAt: inRange, totalCents: 80000, qbInvoiceId: 'Y' })
    const done = await order({ status: 'ready', completedAt: inRange, totalCents: 50000, qbInvoiceId: 'Z' })
    for (const o of [working, cancelled, done]) await attr(o)
    const r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(50000)
  })

  it('respects reporting boundaries (completed_at inside vs outside the range)', async () => {
    const within = await order({ completedAt: new Date('2026-10-04T00:00:00Z'), totalCents: 30000, qbInvoiceId: 'A' })
    const outside = await order({ completedAt: new Date('2026-10-09T00:00:00Z'), totalCents: 99999, qbInvoiceId: 'B' })
    await attr(within)
    await attr(outside)
    const r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(30000)
  })

  it('treats an ad conversion as NOT a completed job', async () => {
    await upsertAdMetric({ serviceCategory: 'ceramic', statDate: '2026-10-03', spendCents: 10000, clicks: 20, conversions: 5, revenueCents: 500000 }, 'admin')
    const r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(0)
    expect(r.invoicedRevenueCents).toBe(0)
    expect(r.adReportedConversions).toBe(5)
    expect(r.roas).toBe(0)
  })

  it('keeps unknown labeled unknown and never fabricates a job from an unverified touch', async () => {
    const o = await order({ completedAt: inRange, totalCents: 10000, qbInvoiceId: 'U' })
    await attr(o, { source: 'unknown', confidence: 'unknown' })
    // A touch with NO linked order must never become a completed job or add revenue.
    await recordAttribution({ source: 'sms', confidence: 'direct', serviceOrderId: null, revenueCents: 99999, occurredAt: inRange }, 'a')
    const r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(10000)
    const unknown = r.bySource.find((s) => s.source === 'unknown')!
    expect(unknown.unknown).toBe(1)
    expect(unknown.revenueCents).toBe(10000)
  })
})

describe('lead linked BEFORE completion, credited dynamically after', () => {
  it('shows no revenue until the order completes + is invoiced, then credits the lead source', async () => {
    const lead = await createLead({ source: 'referral', name: 'Referred Rita', createdAt: inRange }, 'a')
    const o = await order({ status: 'in_progress', completedAt: null }) // not done yet, no invoice
    await linkLeadOutcome(lead.id, { serviceOrderId: o }, 'a') // link before completion, no manual revenue

    let r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(0) // order not completed yet

    // The job completes and is invoiced.
    await pg.query('UPDATE service_orders SET status=$2, completed_at=$3 WHERE id=$1', [o, 'ready', inRange])
    await pg.query('INSERT INTO job_estimates (id, service_order_id, total_cents, qb_invoice_id) VALUES ($1,$2,$3,$4)', [randomUUID(), o, 150000, 'INV-L'])

    r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(150000)
    const referral = r.bySource.find((s) => s.source === 'referral')!
    expect(referral.count).toBe(1)
    expect(referral.revenueCents).toBe(150000)
  })

  it('re-linking supersedes the prior order (append-only); report counts only the latest', async () => {
    const lead = await createLead({ source: 'referral', name: 'Switch', createdAt: inRange }, 'a')
    const orderA = await order({ completedAt: inRange, totalCents: 40000, qbInvoiceId: 'A' })
    const orderB = await order({ completedAt: inRange, totalCents: 70000, qbInvoiceId: 'B' })
    await linkLeadOutcome(lead.id, { serviceOrderId: orderA }, 'a')
    await linkLeadOutcome(lead.id, { serviceOrderId: orderB }, 'a') // relink → A superseded

    const r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(70000)

    const ev = await pg.query(`SELECT event_type FROM marketing_events WHERE event_type = 'attribution_superseded'`)
    expect(ev.rows.length).toBe(1)
  })

  it('A→B→A credits A again (active link follows the lead, not the newest attribution row)', async () => {
    const lead = await createLead({ source: 'referral', name: 'Flip', createdAt: inRange }, 'a')
    const orderA = await order({ completedAt: inRange, totalCents: 40000, qbInvoiceId: 'A' })
    const orderB = await order({ completedAt: inRange, totalCents: 70000, qbInvoiceId: 'B' })
    await linkLeadOutcome(lead.id, { serviceOrderId: orderA }, 'a')
    await linkLeadOutcome(lead.id, { serviceOrderId: orderB }, 'a')
    await linkLeadOutcome(lead.id, { serviceOrderId: orderA }, 'a') // back to A (reuses A's row)

    const r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(40000) // A, not B (newest row), because the lead now points at A
  })
})

describe('linkRecipientOutcome — idempotent, append-only, dynamic revenue', () => {
  it('re-linking never duplicates rows; revenue comes from the invoice, not a manual figure', async () => {
    const c = await createCampaign({ name: 'Reactivation', channel: 'sms', smsCopy: 'Hi' }, 'mgr')
    const customerId = randomUUID()
    await pg.query('INSERT INTO customers (id, display_name) VALUES ($1,$2)', [customerId, 'Recip'])  // satisfy recipient FK
    await insertRecipients(c.id, [{ customerId, channel: 'sms', addressSnapshot: '+15125550123', status: 'pending', renderedBody: 'Hi' }])
    const [rec] = await listRecipients(c.id)
    const orderId = await order({ completedAt: inRange, totalCents: 65000, qbInvoiceId: 'INV-R' })

    await linkRecipientOutcome(rec.id, { bookedOrderId: orderId }, 'mgr') // no manual revenue
    await linkRecipientOutcome(rec.id, { bookedOrderId: orderId }, 'mgr')
    await linkRecipientOutcome(rec.id, { bookedOrderId: orderId }, 'mgr')

    const rows = await pg.query('SELECT id FROM marketing_attribution WHERE service_order_id = $1', [orderId])
    expect(rows.rows).toHaveLength(1)

    const r = await marketingReport(RANGE)
    expect(r.completedJobs).toBe(1)
    expect(r.invoicedRevenueCents).toBe(65000)
  })
})

describe('leads windowing', () => {
  it('counts only leads created inside the range (not leads created later)', async () => {
    await createLead({ source: 'google_ads', name: 'In range', createdAt: inRange }, 'a')
    await createLead({ source: 'google_ads', name: 'Out of range', createdAt: new Date('2026-10-20T00:00:00Z') }, 'a')
    const r = await marketingReport(RANGE)
    expect(r.leads).toBe(1)
  })
})

describe('weekStart', () => {
  it('snaps to Monday', () => {
    expect(weekStart(new Date('2026-10-07T12:00:00Z')).toISOString().slice(0, 10)).toBe('2026-10-05')
    expect(weekStart(new Date('2026-10-05T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-10-05')
  })
})
