/**
 * REGRESSION (red): the employee Quick Entry interpret endpoint must use the SAME shared service
 * interpretation the manager estimate uses, so each entry carries its raw wording, intent, scope
 * (area), and part detection — not just a flat list of matched titles.
 *
 * Gap: this route still runs the old deterministicInterpret + classifyUnmatched pass, returning only
 * `services: [{ title, catalogId, source }]`. That throws away the raw entry, the job-specific area
 * ("passenger seat"), and the part-vs-service intent, so a physical part typed here silently becomes
 * a plain service and a near-miss typo loses its traceable original wording.
 *
 * Proposed contract: `{ ok, entries: Interpretation[] }` (one per entry), each with `entry` (raw),
 * `corrected`, `intent`, `area`, `part`, `candidates`. AI is mocked OFF (deterministic only) — no
 * network. Fails on baseline because the route returns the old title-only shape.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { pushSchema } from 'drizzle-kit/api'
import * as schema from '@/drizzle/schema'

const holder: { db: PgliteDatabase<typeof schema> | null } = { db: null }
vi.mock('@/platform/db', () => ({ getDb: () => holder.db }))
vi.mock('@/apps/settings/db', () => ({
  nlEnabled: async () => true, voiceEnabled: async () => false,
  getBusinessConfig: async () => ({ shopSuppliesEnabled: false, shopSuppliesBps: 0, shopSuppliesCapCents: 0, paymentEnabled: false, paymentBps: 0, paymentLabel: 'Card charge', paymentBasis: 'work_only', defaultTaxBps: 825 }),
  shopSuppliesLabel: async () => 'Shop supplies',
}))
const state = vi.hoisted(() => ({
  role: 'manager' as string | null,
  // AI is OFF by default (deterministic only). A test may plug in a fake model reply; it is run
  // through the REAL parser (index-only choices, grounding of area/part) — no network.
  aiReply: null as null | ((entry: string) => string | Error),
  aiCalls: 0,
}))
vi.mock('@/apps/auth/employee-guard', () => ({
  authenticatedActorFromRequest: async () => (state.role ? { name: 'Someone', role: state.role } : null),
  employeeAuthorizedFromRequest: async () => !!state.role,
}))
vi.mock('@/apps/quick-entry/service-interpret-ai', async (orig) => {
  const real = await orig<typeof import('@/apps/quick-entry/service-interpret-ai')>()
  return {
    ...real,
    serviceAiConfigured: () => !!state.aiReply,
    aiInterpret: async (entry: string, corrected: string, list: Parameters<typeof real.parseAiResponse>[1]) => {
      if (!state.aiReply) return { status: 'unavailable', reason: 'disabled in test' }
      state.aiCalls++
      const reply = state.aiReply(entry)
      if (reply instanceof Error) return { status: 'failed', reason: reply.message }
      const { tokenize } = await import('@/apps/quick-entry/service-interpret')
      return real.parseAiResponse(reply, list, tokenize(corrected))
    },
  }
})
vi.mock('@/apps/quick-entry/interpret-ai', () => ({
  aiConfigured: () => false,
  classifyUnmatched: async (phrases: string[]) => phrases.map((p) => (/call|text|by \d/i.test(p) ? { phrase: p, type: 'note' as const, noteText: p } : { phrase: p, type: 'custom' as const })),
}))

import { seedProductionCatalog, CLEAR_TABLES } from '@/apps/quick-entry/catalog-fixture.test-support'
import { POST } from './route'

const post = (text: string) => POST(new Request('http://x/api/quick-entry/interpret', { method: 'POST', body: JSON.stringify({ text }) }))

let db: PgliteDatabase<typeof schema>
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema })
  holder.db = db
  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1])
  await apply()
})
let CAT: Record<string, string> = {}
beforeEach(async () => {
  for (const t of CLEAR_TABLES) await db.execute(`DELETE FROM ${t}`)
  CAT = await seedProductionCatalog(db)
  state.role = 'manager'; state.aiReply = null; state.aiCalls = 0
})
type Entry = { entry: string; corrected: string; status: string; intent: string; area: string | null; part: { description: string } | null; ai: string; candidates: Array<{ catalogId: string; name: string }> }
const entries = async (text: string) => (await (await post(text)).json()) as { ok: boolean; entries: Entry[]; note: string | null; priceCents: number | null; ai: string }

describe('POST /api/quick-entry/interpret — shared interpretation, raw + scope + intent preserved', () => {
  it('a near-miss typo keeps the raw entry, corrects the wording, and extracts the job-specific area', async () => {
    const res = await post('shamp pass seat')
    const body = await res.json() as { ok: boolean; entries?: Array<{ entry: string; corrected: string; intent: string; area: string | null; candidates: unknown[] }> }
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.entries)).toBe(true)
    const e = body.entries![0]
    expect(e.entry).toBe('shamp pass seat')            // raw wording preserved for traceability
    expect(e.corrected).toBe('shampoo passenger seat')  // shorthand expanded, typo snapped
    expect(e.intent).toBe('service')
    expect(e.area).toBe('passenger seat')               // scope kept SEPARATE from the service identity
    expect(e.candidates.length).toBeGreaterThan(0)
  })

  it('a physical part typed in Quick Entry is classified as a part (so it can route to labor review)', async () => {
    const res = await post('driver-side mirror assembly')
    const body = await res.json() as { ok: boolean; entries?: Array<{ intent: string; part: { description: string } | null }> }
    const e = body.entries![0]
    expect(e.intent).toBe('part')
    expect(e.part?.description).toMatch(/mirror/i)
  })
})

describe('POST /api/quick-entry/interpret — the owner rushed-entry examples', () => {
  it('"paint dr mirr assy" → painting/refinishing work with the driver-side mirror assembly as the area (not a part)', async () => {
    const [e] = (await entries('paint dr mirr assy')).entries
    expect(e).toMatchObject({ entry: 'paint dr mirr assy', intent: 'service', area: 'driver-side mirror assembly', part: null })
    expect(e.candidates.map((c) => c.catalogId)).toContain(CAT.paint_refinish)
  })
  it('"air ducts + ozone" stays ONE request → Complete Odor Treatment', async () => {
    const d = await entries('air ducts + ozone')
    expect(d.entries).toHaveLength(1)
    expect(d.entries[0]).toMatchObject({ status: 'resolved', intent: 'odor', candidates: [{ catalogId: CAT.complete_odor_treatment }] })
  })
  it('"car smells bad" → an odor request that asks which of the three treatments', async () => {
    const [e] = (await entries('car smells bad')).entries
    expect(e).toMatchObject({ status: 'choose', intent: 'odor' })
    expect(e.candidates.map((c) => c.name).sort()).toEqual(['Air Duct Cleaning', 'Complete Odor Treatment', 'Ozone Treatment'])
  })
  it('"replace tires" → asks supply / install customer-supplied / both (nothing assumed)', async () => {
    const [e] = (await entries('replace tires')).entries
    expect(e).toMatchObject({ status: 'choose', intent: 'tires' })
  })
  it('several items, a price, and an instruction: services split, price only to a manager, the instruction becomes a note', async () => {
    const d = await entries('interior detail, wash and wax, 650, call when done')
    expect(d.entries.map((e) => e.entry)).toEqual(['interior detail', 'wash', 'wax'])
    expect(d.priceCents).toBe(65000)
    expect(d.note).toBe('call when done')
    state.role = 'employee'
    expect((await entries('interior detail, 650')).priceCents).toBeNull()   // employees never receive a price
  })
})

describe('POST /api/quick-entry/interpret — real AI path (model reply mocked, real validation)', () => {
  it('AI picks real catalog items by number only; an out-of-range pick and an ungrounded area are dropped', async () => {
    state.aiReply = () => JSON.stringify({ intent: 'service', choices: [999, 1], area: 'rear bumper', question: null })
    const [e] = (await entries('get the gunk off')).entries
    expect(state.aiCalls).toBe(1)
    expect(e.ai).toBe('used')
    expect(e.candidates).toHaveLength(1)           // #999 does not exist → ignored; #1 is a real eligible item
    expect(e.area).toBeNull()                       // "rear bumper" was never typed → not invented
    expect(e.entry).toBe('get the gunk off')        // original wording preserved
  })
  it('established matches never call the AI (fast path)', async () => {
    state.aiReply = () => JSON.stringify({ intent: 'service', choices: [1] })
    const [e] = (await entries('Interior Detail')).entries
    expect(e.status).toBe('resolved')
    expect(state.aiCalls).toBe(0)
  })
  it('AI failure or no key: the entry still comes back (kept as typed) and the response says so', async () => {
    state.aiReply = () => new Error('timeout')
    const d = await entries('zzz qqq')
    expect(d.ai).toBe('failed')
    expect(d.entries).toEqual([expect.objectContaining({ entry: 'zzz qqq', status: 'none' })])
    state.aiReply = null
    const d2 = await entries('get the gunk off')
    expect(d2.ai).toBe('unavailable')
    expect(d2.entries[0].entry).toBe('get the gunk off')
  })
})
