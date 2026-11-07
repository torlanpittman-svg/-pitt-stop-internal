/**
 * End-to-end NONPRODUCTION proof of the insurance-restoration funnel against an in-memory Postgres (PGlite)
 * running the REAL migrations 0046 + 0072 + 0075 + 0076 (not 0074, the held gift-card migration):
 *
 *   synthetic lead with a test photo → claim row + lead + attribution persisted → shop email (fake provider)
 *   → lead linked to a job → estimate written → job completed + QuickBooks-anchored invoice
 *   → restorationReport shows the right funnel, revenue, recorded costs and SEPARATED paid unit costs
 *   → duplicate / replayed submissions and provider failures are handled without a second lead
 *   → missing restoration ad data is UNKNOWN (null), never $0, even when other categories report
 *   → profitability is unmeasured (labor cost is not captured) — no contribution figure exists.
 *
 * Nothing here touches Neon, Postmark, QuickBooks or Google Ads. Ad spend is injected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { parseQuoteRequest, submitQuoteRequest } from './quote-request'
import { linkLeadOutcome } from './attribution'
import { updateLead } from './leads'
import { restorationReport, currentWeekYmd, markDuplicates } from './restoration-report'
import type { AdReporting } from './ads-reporting'
import type { TransactionalEmailProvider, EmailMessage, DeliveryResult } from '@/apps/appointments/notify'

const pg = new PGlite()
const PARENTS = `
  CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text, first_name text, last_name text, phone text, email text, active boolean NOT NULL DEFAULT true);
  CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, customer_name text, status text NOT NULL DEFAULT 'intake',
    completed_at timestamptz, cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), approved_price_cents integer, services jsonb);
  CREATE TABLE job_estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_order_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft', total_cents integer NOT NULL DEFAULT 0, qb_invoice_id text);
  CREATE TABLE job_services (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_estimate_id uuid NOT NULL, title text NOT NULL);
  CREATE TABLE job_line_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_service_id uuid NOT NULL, type text NOT NULL, name text NOT NULL,
    cost_cents integer NOT NULL DEFAULT 0, price_cents integer NOT NULL DEFAULT 0);
  CREATE TABLE retail_invoice_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_estimate_id uuid, qb_invoice_number text, state text);
  CREATE TABLE app_settings (key varchar(80) PRIMARY KEY, value jsonb NOT NULL, type varchar(12) NOT NULL, category varchar(40), label varchar(160),
    description text, updated_by varchar(200), updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
`
beforeAll(async () => {
  await pg.exec(PARENTS)
  for (const m of ['0046_marketing', '0072_marketing_leads_referral', '0075_quote_requests', '0076_restoration_quote_requests', '0076_restoration_quote_requests']) {
    await pg.exec(readFileSync(`drizzle/migrations/manual/${m}.sql`, 'utf8'))
  }
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec(`DELETE FROM quote_requests; DELETE FROM marketing_attribution; DELETE FROM marketing_events; DELETE FROM marketing_leads;
    DELETE FROM job_line_items; DELETE FROM job_services; DELETE FROM job_estimates; DELETE FROM retail_invoice_members; DELETE FROM service_orders; DELETE FROM customers;`)
})

class FakeProvider implements TransactionalEmailProvider {
  readonly name = 'fake'; readonly live = false
  calls: EmailMessage[] = []
  queue: DeliveryResult[] = []
  async send(msg: EmailMessage): Promise<DeliveryResult> { this.calls.push(msg); return this.queue.shift() ?? { status: 'sent', providerMessageId: `pm-${this.calls.length}` } }
}

// A real 1×1 PNG — the "test photo".
const PNG = { name: 'keyed-door.png', contentType: 'image/png', contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }
const LEAD = { service: 'vandalism', name: 'Test Vandal Lead', phone: '(979) 555-0101', email: 'test.vandal@example.invalid', vehicleYear: '2019', vehicleMake: 'Toyota', vehicleModel: 'Camry',
  message: 'Keyed down both doors and broke the rear quarter glass. Glass in the back seat.', photos: [PNG], claimStatus: 'filed', incidentDate: '2026-11-05' }
const ADS_CLICK = { gclid: 'TEST-GCLID-1', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'restoration_vandalism', lp: 'car-vandalism-repair' }
const req = (over: Record<string, unknown> = {}) => { const p = parseQuoteRequest({ ...LEAD, ...over }); if (!p.ok) throw new Error(JSON.stringify(p.errors)); return p.req }
const WEEK = currentWeekYmd(new Date())

type LoadAds = typeof import('./ads-reporting').loadAdReporting
const LIVE_META = () => ({ status: 'live', source: 'google_ads_api', fetchedAt: new Date().toISOString(), error: null, errorKind: null, account: null }) as AdReporting['meta']
/** null = Google Ads API unavailable; a number = a live restoration rollup with that spend (plus a ceramic row). */
const ads = (spendCents: number | null): LoadAds => async () => (spendCents == null
  ? { meta: { status: 'unavailable', source: 'google_ads_api', fetchedAt: null, error: 'google_ads_auth', errorKind: 'auth', account: null }, byCategory: [] }
  : { meta: LIVE_META(),
      byCategory: [{ serviceCategory: 'restoration', spendCents, impressions: 1000, clicks: 40, conversions: 2, revenueCents: 0 }, { serviceCategory: 'ceramic', spendCents: 99900, impressions: 1, clicks: 1, conversions: 0, revenueCents: 0 }] }) as AdReporting
/** LIVE data where only OTHER categories report — the restoration mapping/data is not established. */
const adsCeramicOnly: LoadAds = async () => ({ meta: LIVE_META(), byCategory: [{ serviceCategory: 'ceramic', spendCents: 99900, impressions: 1, clicks: 1, conversions: 0, revenueCents: 0 }] }) as AdReporting

async function one<T = Record<string, unknown>>(q: string, params: unknown[] = []): Promise<T> { const r = await pg.query<T>(q, params); return r.rows[0] }

/** Shop-side simulation: customer → job → estimate (labor + sublet glass) → completed → QB invoice anchor. */
async function fulfil(leadId: string, opts: { invoice?: boolean; cancel?: boolean; laborPrice?: number; subletCost?: number; partCost?: number; total?: number } = {}) {
  const customerId = randomUUID(); const orderId = randomUUID(); const estimateId = randomUUID(); const svcId = randomUUID()
  await pg.query('INSERT INTO customers (id, display_name, phone, email) VALUES ($1,$2,$3,$4)', [customerId, LEAD.name, LEAD.phone, LEAD.email])
  await pg.query('INSERT INTO service_orders (id, customer_id, customer_name, status, services) VALUES ($1,$2,$3,$4,$5)', [orderId, customerId, LEAD.name, 'in_progress', JSON.stringify(['Vandalism restoration - keyed doors + glass cleanup'])])
  await linkLeadOutcome(leadId, { serviceOrderId: orderId, confidence: 'direct' }, 'manager:test')
  const total = opts.total ?? 120000
  await pg.query('INSERT INTO job_estimates (id, service_order_id, status, total_cents) VALUES ($1,$2,$3,$4)', [estimateId, orderId, 'approved', total])
  await pg.query('INSERT INTO job_services (id, job_estimate_id, title) VALUES ($1,$2,$3)', [svcId, estimateId, 'Vandalism restoration'])
  await pg.query('INSERT INTO job_line_items (job_service_id, type, name, cost_cents, price_cents) VALUES ($1,$2,$3,$4,$5)', [svcId, 'labor', 'Restoration labor', 0, opts.laborPrice ?? 80000])
  await pg.query('INSERT INTO job_line_items (job_service_id, type, name, cost_cents, price_cents) VALUES ($1,$2,$3,$4,$5)', [svcId, 'sublet', 'Quarter glass (partner)', opts.subletCost ?? 22000, 30000])
  await pg.query('INSERT INTO job_line_items (job_service_id, type, name, cost_cents, price_cents) VALUES ($1,$2,$3,$4,$5)', [svcId, 'part', 'Touch-up materials', opts.partCost ?? 3000, 10000])
  await updateLead(leadId, { status: 'estimate_sent' }, 'manager:test')
  if (opts.cancel) { await pg.query("UPDATE service_orders SET status='cancelled', cancelled_at=now() WHERE id=$1", [orderId]); return { orderId, estimateId, customerId } }
  await pg.query("UPDATE service_orders SET status='delivered', completed_at=now() WHERE id=$1", [orderId])
  if (opts.invoice !== false) await pg.query("UPDATE job_estimates SET qb_invoice_id='QB-TEST-1001' WHERE id=$1", [estimateId])
  return { orderId, estimateId, customerId }
}

describe('synthetic lead → storage + attribution', () => {
  it('persists the claim row with the photo, damage type, claim status, incident date, landing page and click attribution — before any email', async () => {
    const provider = new FakeProvider()
    const r = await submitQuoteRequest(req(), ADS_CLICK, { provider, requestKey: randomUUID() })
    expect(r.emailed).toBe('sent'); expect(r.replayed).toBe(false)
    const claim = await one<Record<string, unknown>>('SELECT damage_type, claim_status, incident_date::text AS incident_date, landing_page, attribution, jsonb_array_length(photos) AS photos, email_status FROM quote_requests WHERE lead_id=$1', [r.leadId])
    expect(claim).toMatchObject({ damage_type: 'vandalism', claim_status: 'filed', incident_date: '2026-11-05', landing_page: 'car-vandalism-repair', photos: 1, email_status: 'sent' })
    expect(claim.attribution).toEqual(ADS_CLICK)
    // attribution never carries PII
    expect(JSON.stringify(claim.attribution)).not.toMatch(/Vandal|979|example/)
    const lead = await one<Record<string, unknown>>('SELECT source, status, requested_service, notes FROM marketing_leads WHERE id=$1', [r.leadId])
    expect(lead).toMatchObject({ source: 'google_ads', status: 'new', requested_service: 'restoration' })
    expect(String(lead.notes)).toContain('Claim filed'); expect(String(lead.notes)).toContain('Landing page: car-vandalism-repair')
    const attr = await one<{ n: string }>('SELECT count(*)::text AS n FROM marketing_attribution WHERE lead_id=$1 AND source=$2 AND click_id=$3', [r.leadId, 'google_ads', 'TEST-GCLID-1'])
    expect(Number(attr.n)).toBe(1)
    const audit = await one<{ meta: Record<string, unknown> }>("SELECT meta FROM marketing_events WHERE event_type='lead_created' AND entity_id=$1", [r.leadId])
    expect(audit.meta).toMatchObject({ source: 'google_ads', damageType: 'vandalism', landingPage: 'car-vandalism-repair' })
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0].subject).toMatch(/Vandalism or break-in restoration ESTIMATE request/)
    expect(provider.calls[0].text).toMatch(/Do not promise coverage/)
    expect(provider.calls[0].attachments).toHaveLength(1)
  })
  it('an organic visitor with only ?lp= still records the landing page, and a detailing quote stores no damage type', async () => {
    const organic = await submitQuoteRequest(req({ service: 'overspray', claimStatus: 'not_filed', incidentDate: '' }), { lp: 'car-overspray-removal' }, { provider: new FakeProvider(), requestKey: randomUUID() })
    expect(await one('SELECT damage_type, claim_status, incident_date, landing_page FROM quote_requests WHERE lead_id=$1', [organic.leadId]))
      .toEqual({ damage_type: 'overspray', claim_status: 'not_filed', incident_date: null, landing_page: 'car-overspray-removal' })
    const ceramic = await submitQuoteRequest(req({ service: 'ceramic', claimStatus: 'filed', incidentDate: '2026-11-01' }), {}, { provider: new FakeProvider(), requestKey: randomUUID() })
    expect(await one('SELECT damage_type, claim_status, incident_date, landing_page, attribution FROM quote_requests WHERE lead_id=$1', [ceramic.leadId]))
      .toEqual({ damage_type: null, claim_status: null, incident_date: null, landing_page: null, attribution: {} })
  })
})

describe('duplicate and failure handling', () => {
  it('a retry with the same key replays (one lead, one email); a second submission by the same person is flagged duplicate', async () => {
    const provider = new FakeProvider(); const key = randomUUID()
    const a = await submitQuoteRequest(req(), ADS_CLICK, { provider, requestKey: key })
    const b = await submitQuoteRequest(req(), ADS_CLICK, { provider, requestKey: key })
    expect(b.leadId).toBe(a.leadId); expect(b.replayed).toBe(true); expect(provider.calls).toHaveLength(1)
    // same customer, new key, different wording → a second lead, which the report marks as a duplicate of the first
    const c = await submitQuoteRequest(req({ message: 'Sent this twice, sorry' }), { utm_source: 'website', lp: 'car-vandalism-repair' }, { provider, requestKey: randomUUID() })
    expect(c.leadId).not.toBe(a.leadId)
    const r = await restorationReport(WEEK, { loadAds: ads(null) })
    expect(r.leads.total).toBe(2); expect(r.leads.duplicates).toBe(1); expect(r.funnel.leads).toBe(1)
    expect(r.leads.rows.find((l) => l.leadId === c.leadId)?.duplicateOf).toBe(a.leadId)
    // breakdowns count the canonical lead only — they agree with the funnel headline
    expect(Object.values(r.leads.byDamageType).reduce((s, n) => s + n, 0)).toBe(1)
    expect(r.leads.bySource).toEqual({ google_ads: 1 })
  })
  it('a later submission that CONVERTED becomes the canonical lead — never hidden behind the earlier unmatched one', async () => {
    const provider = new FakeProvider()
    const first = await submitQuoteRequest(req({ message: 'First try, never followed up' }), { utm_source: 'website', lp: 'car-vandalism-repair' }, { provider, requestKey: randomUUID() })
    const second = await submitQuoteRequest(req({ message: 'Came back through the ad' }), ADS_CLICK, { provider, requestKey: randomUUID() })
    await fulfil(second.leadId)
    const r = await restorationReport(WEEK, { loadAds: ads(15000) })
    expect(r.funnel.leads).toBe(1); expect(r.leads.duplicates).toBe(1)
    expect(r.leads.rows.find((l) => l.leadId === first.leadId)?.duplicateOf).toBe(second.leadId)
    expect(r.leads.rows.find((l) => l.leadId === second.leadId)?.duplicateOf).toBeNull()
    expect(r.leads.matched).toBe(1); expect(r.leads.bySource).toEqual({ google_ads: 1 })
    expect(r.funnel.completed).toBe(1); expect(r.funnel.invoiced).toBe(1)
  })
  it('a provider failure still saves the lead and the photo, reports emailed=failed, and the report flags it for phone follow-up', async () => {
    const provider = new FakeProvider(); provider.queue.push({ status: 'failed', error: 'postmark 500' })
    const r = await submitQuoteRequest(req(), ADS_CLICK, { provider, requestKey: randomUUID() })
    expect(r.emailed).toBe('failed'); expect(r.leadId).toBeTruthy()
    expect(await one('SELECT email_status, jsonb_array_length(photos) AS photos FROM quote_requests WHERE lead_id=$1', [r.leadId])).toEqual({ email_status: 'failed', photos: 1 })
    const rep = await restorationReport(WEEK, { loadAds: ads(null) })
    expect(rep.leads.emailNotSent).toBe(1); expect(rep.funnel.leads).toBe(1)
  })
  it('markDuplicates matches on normalized phone OR email, never on name', () => {
    const t0 = new Date('2026-11-02T10:00:00Z')
    const rows = markDuplicates([
      { leadId: 'A', phone: '979-555-0101', email: 'a@x.test', createdAt: t0 },
      { leadId: 'B', phone: '(979) 555-0101', email: 'other@x.test', createdAt: new Date(t0.getTime() + 1) },
      { leadId: 'C', phone: null, email: 'A@X.TEST', createdAt: new Date(t0.getTime() + 2) },
      { leadId: 'D', phone: '979-555-0199', email: 'd@x.test', createdAt: new Date(t0.getTime() + 3) },
    ])
    expect(rows.map((r) => [r.leadId, r.duplicateOf])).toEqual([['A', null], ['B', 'A'], ['C', 'A'], ['D', null]])
  })
  it('markDuplicates prefers the linked/progressed lead as canonical over the merely earlier one', () => {
    const t0 = new Date('2026-11-02T10:00:00Z')
    const rows = markDuplicates([
      { leadId: 'A', phone: '979-555-0101', email: 'a@x.test', createdAt: t0, serviceOrderId: null, status: 'new' },
      { leadId: 'B', phone: '(979) 555-0101', email: null, createdAt: new Date(t0.getTime() + 1), serviceOrderId: 'SO-1', status: 'won' },
    ])
    expect(rows.map((r) => [r.leadId, r.duplicateOf])).toEqual([['A', 'B'], ['B', null]])
  })
  it('REGRESSION (independent review): a bridging lead merges two existing groups transitively — one canonical, not two', () => {
    const t0 = new Date('2026-11-02T10:00:00Z')
    // A(p1,e1) and B(p2,e2) are separate groups until C(p1,e2) bridges them; C converted, so C is canonical.
    const rows = markDuplicates([
      { leadId: 'A', phone: '979-555-0101', email: 'a@x.test', createdAt: t0 },
      { leadId: 'B', phone: '979-555-0202', email: 'b@x.test', createdAt: new Date(t0.getTime() + 1) },
      { leadId: 'C', phone: '(979) 555-0101', email: 'B@X.TEST', createdAt: new Date(t0.getTime() + 2), serviceOrderId: 'SO-1', status: 'won', orderCompleted: true },
    ])
    expect(rows.map((r) => [r.leadId, r.duplicateOf])).toEqual([['A', 'C'], ['B', 'C'], ['C', null]])
  })
  it('a completed linked lead outranks an older CANCELLED linked lead — being linked is not enough', () => {
    const t0 = new Date('2026-11-02T10:00:00Z')
    const rows = markDuplicates([
      { leadId: 'A', phone: '979-555-0101', email: null, createdAt: t0, serviceOrderId: 'SO-A', status: 'booked', orderCancelled: true },
      { leadId: 'B', phone: '(979) 555-0101', email: null, createdAt: new Date(t0.getTime() + 1), serviceOrderId: 'SO-B', status: 'won', orderCompleted: true },
    ])
    expect(rows.map((r) => [r.leadId, r.duplicateOf])).toEqual([['A', 'B'], ['B', null]])
  })
  it('REGRESSION end-to-end: bridged contacts collapse to ONE unique lead and the completed one is canonical', async () => {
    const provider = new FakeProvider()
    const a = await submitQuoteRequest(req({ phone: '(979) 555-0101', email: 'bridge.a@example.invalid', message: 'first contact' }), {}, { provider, requestKey: randomUUID() })
    const b = await submitQuoteRequest(req({ phone: '(979) 555-0202', email: 'bridge.b@example.invalid', message: 'second contact' }), {}, { provider, requestKey: randomUUID() })
    const c = await submitQuoteRequest(req({ phone: '(979) 555-0101', email: 'bridge.b@example.invalid', message: 'third, bridging both' }), ADS_CLICK, { provider, requestKey: randomUUID() })
    await fulfil(c.leadId)
    const r = await restorationReport(WEEK, { loadAds: ads(null) })
    expect(r.funnel.leads).toBe(1); expect(r.leads.duplicates).toBe(2); expect(r.leads.matched).toBe(1)
    expect(r.leads.rows.find((l) => l.leadId === a.leadId)?.duplicateOf).toBe(c.leadId)
    expect(r.leads.rows.find((l) => l.leadId === b.leadId)?.duplicateOf).toBe(c.leadId)
    expect(r.leads.rows.find((l) => l.leadId === c.leadId)?.duplicateOf).toBeNull()
    expect(r.funnel.completed).toBe(1); expect(r.funnel.invoiced).toBe(1)
  })
})

describe('lead → estimate → completed job → invoice → report', () => {
  it('reports the funnel, QB-anchored revenue, recorded costs and SEPARATED paid unit costs; profitability stays unmeasured', async () => {
    const provider = new FakeProvider()
    const lead = await submitQuoteRequest(req(), ADS_CLICK, { provider, requestKey: randomUUID() })
    // an organic overspray lead that stays unqualified/unmatched
    await submitQuoteRequest(req({ service: 'overspray', phone: '(979) 555-0177', email: 'other.person@example.invalid', name: 'Other Person', message: 'Overspray on hood' }), { lp: 'car-overspray-removal' }, { provider, requestKey: randomUUID() })
    await fulfil(lead.leadId, { total: 120000, laborPrice: 80000, subletCost: 22000, partCost: 3000 })

    const r = await restorationReport(WEEK, { loadAds: ads(15000) })
    expect(r.funnel).toEqual({ leads: 2, qualified: 1, estimates: 1, booked: 1, completed: 1, invoiced: 1, cancelled: 0 })
    expect(r.leads.matched).toBe(1); expect(r.leads.unmatched).toBe(1)
    expect(r.leads.byDamageType).toEqual({ vandalism: 1, overspray: 1 })
    expect(r.leads.bySource).toEqual({ google_ads: 1, website: 1 })
    expect(r.leads.byLandingPage).toEqual({ 'car-vandalism-repair': 1, 'car-overspray-removal': 1 })
    expect(r.leads.byClaimStatus).toEqual({ filed: 2 })
    expect(r.revenue.invoicedCents).toBe(120000); expect(r.revenue.quotedUninvoicedCents).toBe(0); expect(r.revenue.avgInvoicedTicketCents).toBe(120000)
    expect(r.revenue.byDamageType).toEqual({ vandalism: { invoicedCents: 120000, orders: 1 } })
    expect(r.revenue.bySource).toEqual({ google_ads: { invoicedCents: 120000, orders: 1 } })
    expect(r.costs).toEqual({ partsCostCents: 3000, subletCostCents: 22000, profitability: 'unmeasured' })
    expect(r.ads.spendCents).toBe(15000); expect(r.ads.clicks).toBe(40)
    expect(r.unit.paidLeads).toBe(1)                                 // only the Google Ads lead
    expect(r.unit.costPerPaidLeadCents).toBe(15000)                  // $150 ÷ 1 paid lead (website lead excluded)
    expect(r.unit.blendedCostPerCompletedJobCents).toBe(15000)       // $150 ÷ 1 completed job (all channels)
    expect(r.unit.paidNewCustomersInvoiced).toBe(1)
    expect(r.unit.paidCacCents).toBe(15000)                          // $150 ÷ 1 new invoiced paid customer
    expect(r.orders[0]).toMatchObject({ damageType: 'vandalism', source: 'google_ads', invoicedCents: 120000, leadId: lead.leadId, newCustomer: true })
    expect(r.caveats.join(' ')).toMatch(/UNMEASURED/)
    // no profit/contribution or modeled-labor FIGURES exist in the numeric payload (the caveat text explains why)
    expect(JSON.stringify({ unit: r.unit, costs: r.costs })).not.toMatch(/contribution|laborCost/i)
  })
  it('a completed job WITHOUT a QuickBooks anchor is quoted, not revenue; unknown ad spend yields null unit costs — never zero', async () => {
    const lead = await submitQuoteRequest(req(), ADS_CLICK, { provider: new FakeProvider(), requestKey: randomUUID() })
    await fulfil(lead.leadId, { invoice: false, total: 90000 })
    const r = await restorationReport(WEEK, { loadAds: ads(null) })
    expect(r.funnel.completed).toBe(1); expect(r.funnel.invoiced).toBe(0)
    expect(r.revenue.invoicedCents).toBe(0); expect(r.revenue.quotedUninvoicedCents).toBe(90000)
    expect(r.ads.spendCents).toBeNull()
    expect(r.unit.costPerPaidLeadCents).toBeNull(); expect(r.unit.blendedCostPerCompletedJobCents).toBeNull(); expect(r.unit.paidCacCents).toBeNull()
    // an uninvoiced job never enters the paid-CAC denominator even when the spend is known
    const r2 = await restorationReport(WEEK, { loadAds: ads(15000) })
    expect(r2.unit.paidNewCustomersInvoiced).toBe(0); expect(r2.unit.paidCacCents).toBeNull()
    expect(r.caveats.join(' ')).toMatch(/unavailable/i)
  })
  it('REGRESSION: live ad data with ONLY a ceramic rollup (no restoration mapping) is unknown spend, not $0', async () => {
    const lead = await submitQuoteRequest(req(), ADS_CLICK, { provider: new FakeProvider(), requestKey: randomUUID() })
    await fulfil(lead.leadId)
    const r = await restorationReport(WEEK, { loadAds: adsCeramicOnly })
    expect(r.ads.meta.status).toBe('live')
    expect(r.ads.spendCents).toBeNull()                              // was 0 before the fix
    expect(r.ads.clicks).toBeNull(); expect(r.ads.conversions).toBeNull()
    expect(r.unit.costPerPaidLeadCents).toBeNull(); expect(r.unit.blendedCostPerCompletedJobCents).toBeNull(); expect(r.unit.paidCacCents).toBeNull()
    expect(r.caveats.join(' ')).toMatch(/unknown — not \$0/)
  })
  it('mixed channels: organic and unknown-source completed jobs count in blended cost but never in the paid denominators', async () => {
    const provider = new FakeProvider()
    const paid = await submitQuoteRequest(req(), ADS_CLICK, { provider, requestKey: randomUUID() })
    const organic = await submitQuoteRequest(req({ phone: '(979) 555-0177', email: 'organic@example.invalid', name: 'Organic Person' }), { utm_source: 'website', lp: 'car-vandalism-repair' }, { provider, requestKey: randomUUID() })
    await fulfil(paid.leadId, { total: 120000 })
    await fulfil(organic.leadId, { total: 60000 })
    // an unknown-source restoration job (no lead, classified from job text)
    const orderId = randomUUID()
    await pg.query("INSERT INTO service_orders (id, status, completed_at, services) VALUES ($1,'ready',now(),$2)", [orderId, JSON.stringify(['Overspray removal'])])
    await pg.query("INSERT INTO job_estimates (service_order_id, total_cents, qb_invoice_id) VALUES ($1,30000,'QB-TEST-1002')", [orderId])

    const r = await restorationReport(WEEK, { loadAds: ads(20000) })
    expect(r.funnel.completed).toBe(3); expect(r.funnel.invoiced).toBe(3)
    expect(r.revenue.bySource).toEqual({
      google_ads: { invoicedCents: 120000, orders: 1 },
      website: { invoicedCents: 60000, orders: 1 },
      unknown: { invoicedCents: 30000, orders: 1 },
    })
    expect(r.unit.paidLeads).toBe(1)
    expect(r.unit.costPerPaidLeadCents).toBe(20000)                  // $200 ÷ 1 paid lead
    expect(r.unit.blendedCostPerCompletedJobCents).toBe(6667)        // $200 ÷ 3 completed jobs, labelled blended
    expect(r.unit.paidNewCustomersInvoiced).toBe(1)                  // organic + unknown jobs excluded
    expect(r.unit.paidCacCents).toBe(20000)
  })
  it('a cancelled job is never a completion and earns no revenue; a lost lead is not qualified', async () => {
    const a = await submitQuoteRequest(req(), ADS_CLICK, { provider: new FakeProvider(), requestKey: randomUUID() })
    await fulfil(a.leadId, { cancel: true })
    const b = await submitQuoteRequest(req({ phone: '(979) 555-0133', email: 'lost@example.invalid', service: 'water_damage' }), {}, { provider: new FakeProvider(), requestKey: randomUUID() })
    await updateLead(b.leadId, { status: 'lost' }, 'manager:test')
    const r = await restorationReport(WEEK, { loadAds: ads(5000) })
    expect(r.funnel).toMatchObject({ leads: 2, qualified: 1, booked: 1, completed: 0, invoiced: 0, cancelled: 1 })
    expect(r.revenue.invoicedCents).toBe(0); expect(r.unit.blendedCostPerCompletedJobCents).toBeNull(); expect(r.unit.paidCacCents).toBeNull(); expect(r.orders).toEqual([])
  })
  it('a repeat customer counts every completed order once, but only the NEW-customer paid job enters paid CAC', async () => {
    const lead = await submitQuoteRequest(req(), ADS_CLICK, { provider: new FakeProvider(), requestKey: randomUUID() })
    const first = await fulfil(lead.leadId, { total: 50000 })
    // make the first job unambiguously earlier, then add a second invoiced job for the SAME customer
    await pg.query("UPDATE service_orders SET completed_at = now() - interval '1 minute' WHERE id=$1", [first.orderId])
    const orderId = randomUUID(); const estId = randomUUID()
    await pg.query("INSERT INTO service_orders (id, customer_id, status, completed_at, services) VALUES ($1,$2,'ready',now(),$3)", [orderId, first.customerId, JSON.stringify(['Overspray removal'])])
    await pg.query("INSERT INTO job_estimates (id, service_order_id, total_cents, qb_invoice_id) VALUES ($1,$2,30000,'QB-TEST-1002')", [estId, orderId])
    const r = await restorationReport(WEEK, { loadAds: ads(10000) })
    expect(r.funnel.completed).toBe(2); expect(r.revenue.invoicedCents).toBe(80000); expect(r.revenue.repeatCustomers).toBe(1)
    expect(r.revenue.byDamageType).toEqual({ vandalism: { invoicedCents: 50000, orders: 1 }, unclassified: { invoicedCents: 30000, orders: 1 } })
    const second = r.orders.find((o) => o.serviceOrderId === orderId)
    expect(second?.newCustomer).toBe(false)                          // the repeat job is not an acquisition
    expect(r.unit.blendedCostPerCompletedJobCents).toBe(5000)        // $100 ÷ 2 jobs (blended keeps both)
    expect(r.unit.paidNewCustomersInvoiced).toBe(1)                  // one distinct new customer
    expect(r.unit.paidCacCents).toBe(10000)                          // $100 ÷ 1 — repeat job excluded
  })
  it('an unrelated ceramic job completed in the window never enters the restoration report', async () => {
    const orderId = randomUUID()
    await pg.query("INSERT INTO service_orders (id, status, completed_at, services) VALUES ($1,'ready',now(),$2)", [orderId, JSON.stringify(['Ceramic coating'])])
    await pg.query("INSERT INTO job_estimates (service_order_id, total_cents, qb_invoice_id) VALUES ($1,200000,'QB-TEST-1003')", [orderId])
    const r = await restorationReport(WEEK, { loadAds: ads(10000) })
    expect(r.funnel.completed).toBe(0); expect(r.revenue.invoicedCents).toBe(0); expect(r.orders).toEqual([])
  })
})
