/**
 * PGlite integration test for quote-request idempotency: runs the REAL migrations (0046 + 0072 + 0075 —
 * deliberately NOT 0074, the held gift-card migration) and the real submit path against an in-memory
 * Postgres. Nothing here touches a Neon database or a real email provider.
 *
 * LIMITATION (stated, not hidden): PGlite is a single connection, so statements execute serially. These
 * tests prove the claim/fence/replay LOGIC; the cross-connection guarantee itself rests on (a) the
 * single-statement CTE that creates claim + lead + audit all-or-nothing under the UNIQUE request_key,
 * and (b) the email_attempts fence (conditional UPDATEs) gating every provider send — both of which hold
 * under READ COMMITTED on real Postgres regardless of connection count.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import {
  parseQuoteRequest, submitQuoteRequest, quotePayloadHash,
  QuoteRequestConflictError, QuoteStillProcessingError,
} from './quote-request'
import type { TransactionalEmailProvider, EmailMessage, DeliveryResult } from '@/apps/appointments/notify'

const pg = new PGlite()
// Parents that 0046's cross-module FKs expect (same shape the other marketing integration tests use).
const PARENTS = `CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name varchar(120), last_name varchar(120),
  display_name varchar(240), company varchar(240), phone varchar(40), normalized_phone varchar(20),
  email varchar(240), normalized_email varchar(240), customer_type varchar(20) NOT NULL DEFAULT 'retail',
  active boolean NOT NULL DEFAULT true, source varchar(20) NOT NULL DEFAULT 'autoleap', source_key varchar(240),
  autoleap_customer_id varchar(120), quickbooks_customer_id varchar(120), autoleap_vehicle_count integer,
  source_values jsonb NOT NULL DEFAULT '{}', created_by_import_batch_id uuid,
  first_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, status text);`

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0072_marketing_leads_referral.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0075_quote_requests.sql', 'utf8'))
  // Idempotency: 0075 must be safe to re-run.
  await pg.exec(readFileSync('drizzle/migrations/manual/0075_quote_requests.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec('DELETE FROM quote_requests; DELETE FROM marketing_attribution; DELETE FROM marketing_events; DELETE FROM marketing_leads;')
})

/** Scripted provider: shifts results off a queue (functions may delay), default 'sent'. Logs every call. */
class FakeProvider implements TransactionalEmailProvider {
  readonly name = 'fake'
  readonly live = false
  calls: EmailMessage[] = []
  queue: Array<DeliveryResult | (() => Promise<DeliveryResult>)> = []
  async send(msg: EmailMessage): Promise<DeliveryResult> {
    this.calls.push(msg)
    const next = this.queue.shift() ?? { status: 'sent' as const, providerMessageId: `pm-${this.calls.length}` }
    return typeof next === 'function' ? next() : next
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PNG = { name: 'scratch.png', contentType: 'image/png', contentBase64: 'iVBORw0KGgo=' }
const body = { service: 'ceramic', name: 'Jane Doe', phone: '(979) 555-0199', email: 'jane@example.com', vehicleYear: '2020', vehicleMake: 'Cadillac', vehicleModel: 'XT6', message: 'Light swirls', photos: [PNG] }
function req(overrides: Record<string, unknown> = {}) {
  const parsed = parseQuoteRequest({ ...body, ...overrides })
  if (!parsed.ok) throw new Error(`test payload invalid: ${JSON.stringify(parsed.errors)}`)
  return parsed.req
}
const KEY = 'd3b07384-d9a0-4c97-9a23-8f63e1a2b4c5'
const FAST = { pollMs: 15, polls: 40 } // keep staleMs at its default so a live claim is never "stale" here

const leadCount = async () => ((await pg.query('SELECT count(*)::int AS n FROM marketing_leads')).rows[0] as { n: number }).n
const requestRow = async (key: string) =>
  (await pg.query('SELECT * FROM quote_requests WHERE request_key = $1', [key])).rows[0] as
  { id: string; lead_id: string | null; email_status: string; email_error: string | null; email_attempts: number; photos: typeof PNG[] } | undefined

describe('fresh submission', () => {
  it('persists the claim row with photos BEFORE sending, creates one lead with an honest note, sends once', async () => {
    const provider = new FakeProvider()
    const r = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    expect(r.emailed).toBe('sent')
    expect(r.replayed).toBe(false)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0].attachments).toHaveLength(1)
    expect(await leadCount()).toBe(1)
    const row = await requestRow(KEY)
    expect(row?.lead_id).toBe(r.leadId)
    expect(row?.email_status).toBe('sent')
    expect(row?.email_attempts).toBe(1)
    expect(row?.photos).toEqual([PNG]) // the durable copy, independent of the email
    // The lead note states where the photos live — it does NOT claim they were emailed.
    const { rows } = await pg.query('SELECT notes FROM marketing_leads WHERE id = $1', [r.leadId])
    expect((rows[0] as { notes: string }).notes).toContain(`photo(s) saved with quote request ${row!.id}`)
    expect((rows[0] as { notes: string }).notes).not.toContain('emailed')
  })

  it('a missing/invalid request key still submits exactly once under a server-generated key', async () => {
    const provider = new FakeProvider()
    const r = await submitQuoteRequest(req(), null, { provider, requestKey: 'nope' })
    expect(r.emailed).toBe('sent')
    expect(await leadCount()).toBe(1)
    const { rows } = await pg.query('SELECT request_key FROM quote_requests')
    expect(rows).toHaveLength(1)
    expect((rows[0] as { request_key: string }).request_key).not.toBe('nope')
  })
})

describe('replay of the same request', () => {
  it('after a successful send: same lead, no second email, no second lead', async () => {
    const provider = new FakeProvider()
    const first = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    const second = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    expect(second.leadId).toBe(first.leadId)
    expect(second.emailed).toBe('sent')
    expect(second.replayed).toBe(true)
    expect(provider.calls).toHaveLength(1)
    expect(await leadCount()).toBe(1)
  })

  it('after a definite failure: retries the send on the SAME lead, then reports sent', async () => {
    const provider = new FakeProvider()
    provider.queue.push({ status: 'failed', error: 'Could not connect to Postmark (ECONNREFUSED).', retryable: true })
    const first = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    expect(first.emailed).toBe('failed')
    expect((await requestRow(KEY))?.photos).toEqual([PNG]) // photos survived the failed send
    const second = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    expect(second.emailed).toBe('sent')
    expect(second.leadId).toBe(first.leadId)
    expect(provider.calls).toHaveLength(2)
    expect(await leadCount()).toBe(1)
    expect((await requestRow(KEY))?.email_attempts).toBe(2)
  })

  it("after 'uncertain': NEVER re-sends (the email may already be in the inbox) and says so", async () => {
    const provider = new FakeProvider()
    provider.queue.push({ status: 'uncertain', error: 'Delivery uncertain — the email may have been delivered.' })
    const first = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    expect(first.emailed).toBe('uncertain')
    const second = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    expect(second.emailed).toBe('uncertain')
    expect(second.replayed).toBe(true)
    expect(second.error).toContain('uncertain')
    expect(provider.calls).toHaveLength(1)
  })

  it('a provider that THROWS after the lead is saved is recorded as uncertain — the lead is still returned', async () => {
    const provider = new FakeProvider()
    provider.queue.push(() => Promise.reject(new Error('postmark client exploded')))
    const r = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    expect(r.leadId).toBeTruthy() // never falsely "unsaved"
    expect(r.emailed).toBe('uncertain')
    expect(r.error).toContain('postmark client exploded')
    expect(await leadCount()).toBe(1)
    // And the replay respects the uncertain terminal state: no resend.
    const again = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    expect(again.emailed).toBe('uncertain')
    expect(provider.calls).toHaveLength(1)
  })
})

describe('conflicting reuse', () => {
  it('the same key with DIFFERENT content conflicts — it never returns the other payload’s result', async () => {
    const provider = new FakeProvider()
    const first = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    await expect(submitQuoteRequest(req({ message: 'Totally different request' }), null, { provider, requestKey: KEY }))
      .rejects.toBeInstanceOf(QuoteRequestConflictError)
    expect(provider.calls).toHaveLength(1)
    expect(await leadCount()).toBe(1)
    expect((await requestRow(KEY))?.lead_id).toBe(first.leadId) // stored outcome untouched
  })
})

describe('concurrent duplicate submissions', () => {
  it('two simultaneous submits with one key → one claim, one lead, ONE provider call, same leadId back', async () => {
    const provider = new FakeProvider()
    const gate = deferred<DeliveryResult>()
    provider.queue.push(() => gate.promise) // hold the winner inside its send while the loser arrives
    const a = submitQuoteRequest(req(), null, { provider, requestKey: KEY, replay: FAST })
    const b = submitQuoteRequest(req(), null, { provider, requestKey: KEY, replay: FAST })
    setTimeout(() => gate.resolve({ status: 'sent', providerMessageId: 'pm-1' }), 60)
    const [ra, rb] = await Promise.all([a, b])
    expect(provider.calls).toHaveLength(1)
    expect(await leadCount()).toBe(1)
    expect(ra.leadId).toBe(rb.leadId)
    expect(ra.emailed).toBe('sent')
    expect(rb.emailed).toBe('sent')
    expect([ra.replayed, rb.replayed].sort()).toEqual([false, true]) // exactly one owner, one replay
  })

  it('a loser that exhausts its polls while the owner is mid-flight reports "still processing" — not a failure', async () => {
    const provider = new FakeProvider()
    const gate = deferred<DeliveryResult>()
    provider.queue.push(() => gate.promise)
    const a = submitQuoteRequest(req(), null, { provider, requestKey: KEY, replay: FAST })
    const b = submitQuoteRequest(req(), null, { provider, requestKey: KEY, replay: { pollMs: 5, polls: 2 } })
    await expect(b).rejects.toBeInstanceOf(QuoteStillProcessingError)
    gate.resolve({ status: 'sent', providerMessageId: 'pm-1' })
    expect((await a).emailed).toBe('sent')
    expect(provider.calls).toHaveLength(1)
    expect(await leadCount()).toBe(1)
  })
})

describe('all-or-nothing claim (single-statement CTE)', () => {
  const arm = (table: string, when = '') => pg.exec(
    `CREATE OR REPLACE FUNCTION quote_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
     CREATE TRIGGER quote_test_boom_trg BEFORE INSERT ON ${table} FOR EACH ROW ${when} EXECUTE FUNCTION quote_test_boom();`)
  const disarm = (table: string) => pg.exec(`DROP TRIGGER IF EXISTS quote_test_boom_trg ON ${table};`)

  it('a failure writing the AUDIT event rolls back the lead AND the claim; the retry then succeeds fully', async () => {
    const provider = new FakeProvider()
    await arm('marketing_events')
    try {
      await expect(submitQuoteRequest(req(), null, { provider, requestKey: KEY })).rejects.toMatchObject({ cause: { message: expect.stringContaining('injected failure') } })
    } finally { await disarm('marketing_events') }
    expect(await requestRow(KEY)).toBeUndefined() // no lead-less claim
    expect(await leadCount()).toBe(0)             // no orphaned lead
    expect(((await pg.query('SELECT count(*)::int AS n FROM marketing_events')).rows[0] as { n: number }).n).toBe(0)
    expect(provider.calls).toHaveLength(0)        // and certainly no email
    const r = await submitQuoteRequest(req(), null, { provider, requestKey: KEY })
    expect(r.emailed).toBe('sent')
    expect(await leadCount()).toBe(1)
    expect((await requestRow(KEY))?.lead_id).toBe(r.leadId)
  })

  it('a failure writing the LEAD rolls back the claim too — nothing partial survives', async () => {
    const provider = new FakeProvider()
    await arm('marketing_leads')
    try {
      await expect(submitQuoteRequest(req(), null, { provider, requestKey: KEY })).rejects.toMatchObject({ cause: { message: expect.stringContaining('injected failure') } })
    } finally { await disarm('marketing_leads') }
    expect(await requestRow(KEY)).toBeUndefined()
    expect(await leadCount()).toBe(0)
    expect(provider.calls).toHaveLength(0)
  })
})

describe('crash recovery and delayed owners (the send fence)', () => {
  /** Recreates the exact row state a crash leaves behind: claim + lead exist (atomic), send in the given state. */
  async function craftClaim(key: string, opts: { attempts: number; ageSeconds: number }) {
    const leadId = randomUUID()
    await pg.query(`INSERT INTO marketing_leads (id, name, source, status) VALUES ($1, 'Jane Doe', 'website', 'new')`, [leadId])
    await pg.query(
      `INSERT INTO quote_requests (request_key, payload_hash, lead_id, email_attempts, photos, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6))`,
      [key, quotePayloadHash(req()), leadId, opts.attempts, JSON.stringify([PNG]), opts.ageSeconds],
    )
    return leadId
  }

  it('owner died before fencing a send (attempts=0): recovery sends ONCE and creates NO second lead, even with two concurrent retries', async () => {
    const leadId = await craftClaim(KEY, { attempts: 0, ageSeconds: 60 })
    const provider = new FakeProvider()
    const opts = { provider, requestKey: KEY, replay: { pollMs: 5, polls: 10, staleMs: 1000 } }
    const [a, b] = await Promise.all([submitQuoteRequest(req(), null, opts), submitQuoteRequest(req(), null, opts)])
    expect(provider.calls).toHaveLength(1) // the fence (0→1) has exactly one winner
    expect(await leadCount()).toBe(1)      // the crashed owner's lead is reused, never duplicated
    expect(a.leadId).toBe(leadId)
    expect(b.leadId).toBe(leadId)
    expect([a.emailed, b.emailed]).toEqual(['sent', 'sent'])
  })

  it('a fenced send that never recorded its outcome (attempts>0, stale) resolves to uncertain — never resent', async () => {
    const leadId = await craftClaim(KEY, { attempts: 1, ageSeconds: 60 })
    const provider = new FakeProvider()
    const r = await submitQuoteRequest(req(), null, { provider, requestKey: KEY, replay: { pollMs: 5, polls: 3, staleMs: 1000 } })
    expect(r.leadId).toBe(leadId)
    expect(r.emailed).toBe('uncertain')
    expect(provider.calls).toHaveLength(0) // the earlier send may have reached the inbox
    expect((await requestRow(KEY))?.email_status).toBe('uncertain')
  })

  it('a merely DELAYED owner cannot double-send: the watcher only marks uncertain, and the live sender upgrades it to the truth', async () => {
    const provider = new FakeProvider()
    const gate = deferred<DeliveryResult>()
    provider.queue.push(() => gate.promise)
    const owner = submitQuoteRequest(req(), null, { provider, requestKey: KEY, replay: FAST })
    await wait(80) // owner has claimed and fenced (attempts=1) and is parked inside provider.send
    const watcher = await submitQuoteRequest(req(), null, { provider, requestKey: KEY, replay: { pollMs: 5, polls: 3, staleMs: 40 } })
    expect(watcher.emailed).toBe('uncertain') // the in-flight send MAY land — the watcher must not resend
    expect(provider.calls).toHaveLength(1)    // …and it didn't
    gate.resolve({ status: 'sent', providerMessageId: 'pm-1' })
    const done = await owner
    expect(done.emailed).toBe('sent')
    expect(await leadCount()).toBe(1)
    expect((await requestRow(KEY))?.email_status).toBe('sent') // the definite outcome upgraded the uncertain marker
  })

  it('a DB failure while recording the outcome never claims "unsaved": honest result, and the state blocks any resend', async () => {
    const provider = new FakeProvider()
    await pg.exec(
      `CREATE OR REPLACE FUNCTION quote_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
       CREATE TRIGGER quote_outcome_boom_trg BEFORE UPDATE ON quote_requests FOR EACH ROW WHEN (NEW.email_status = 'sent') EXECUTE FUNCTION quote_test_boom();`)
    const r = await (async () => {
      try { return await submitQuoteRequest(req(), null, { provider, requestKey: KEY }) }
      finally { await pg.exec('DROP TRIGGER IF EXISTS quote_outcome_boom_trg ON quote_requests;') }
    })()
    expect(r.leadId).toBeTruthy()
    expect(r.emailed).toBe('sent') // the provider DID accept it — the response says so
    expect(r.error).toContain('Recording the outcome failed')
    expect((await requestRow(KEY))?.email_status).toBe('processing') // unfence-able: nothing can send again
    await wait(30)
    const again = await submitQuoteRequest(req(), null, { provider, requestKey: KEY, replay: { pollMs: 5, polls: 3, staleMs: 10 } })
    expect(again.emailed).toBe('uncertain') // resolved honestly, still no resend
    expect(provider.calls).toHaveLength(1)
    expect(again.leadId).toBe(r.leadId)
  })
})
