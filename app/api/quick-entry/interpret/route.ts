/**
 * POST /api/quick-entry/interpret  { text }
 * Turns an employee's rushed free text into reviewable suggestions for the SAME Quick Entry lines,
 * using the SAME shared service interpretation as the manager estimate (apps/quick-entry/
 * service-match-db): shorthand + typo correction, exact names / approved alternate names, the owner's
 * odor rules, tire clarification, part-vs-service detection, the job-specific area, and — only when
 * there is no established match — the constrained AI pass, which can only pick real catalog items.
 * Each entry keeps the employee's original wording. Nothing is saved here.
 *
 * The deterministic core still owns the explicit work price (returned ONLY to a manager/admin), and
 * the old note classifier still turns an instruction ("call when done") into an internal note
 * instead of a service. AI unavailable → deterministic results only; the typed text is never lost.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { nlEnabled } from '@/apps/settings/db'
import { deterministicInterpret, priceFromToken, splitWorkEntries } from '@/apps/quick-entry/interpret'
import { classifyUnmatched } from '@/apps/quick-entry/interpret-ai'
import { interpretServiceEntry, listCatalogChoices, type AiStatus } from '@/apps/quick-entry/service-match-db'
import { isOdorFamily } from '@/apps/quick-entry/service-interpret'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (!(await nlEnabled())) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 })
  const actor = await authenticatedActorFromRequest(req)
  const priceAllowed = actor?.role === 'manager' || actor?.role === 'admin'

  const body = await req.json().catch(() => ({})) as { text?: string }
  const text = (body.text ?? '').slice(0, 2000)
  if (!text.trim()) return NextResponse.json({ ok: true, entries: [], note: null, priceCents: null, priceAllowed, ai: 'skipped' })

  // Price: the deterministic core only (a delimited price token, else a $-amount anywhere).
  const { priceCents } = deterministicInterpret(text, [])
  const pieces = splitWorkEntries(text, isOdorFamily).filter((p) => priceFromToken(p) == null)

  const results = await Promise.all(pieces.map((p) => interpretServiceEntry(p)))

  // Pieces nothing recognized: an instruction becomes an internal note (not a service line).
  const unknown = results.map((r, i) => ({ r, i })).filter(({ r }) => r.interpretation.status === 'none' && r.interpretation.intent === 'unknown')
  const notes: string[] = []
  const asNote = new Set<number>()
  if (unknown.length) {
    const titles = (await listCatalogChoices()).map((c) => c.name)
    const cls = await classifyUnmatched(unknown.map(({ r }) => r.interpretation.entry), titles)
    cls.forEach((c, k) => {
      if (c.type !== 'note') return
      const n = (c.noteText || c.phrase).trim().slice(0, 200)
      if (n) { notes.push(n); asNote.add(unknown[k].i) }
    })
  }

  const entries = results.filter((_, i) => !asNote.has(i)).map(({ interpretation: it, choices, ai }) => ({
    entry: it.entry, corrected: it.corrected, status: it.status, intent: it.intent, area: it.area, part: it.part,
    question: it.question, source: it.source, ai,
    candidates: choices.map((c) => ({ catalogId: c.catalogId, name: c.name, description: c.description, role: c.role })),
  }))
  const statuses = new Set<AiStatus>(results.map((r) => r.ai))
  const ai: AiStatus = statuses.has('used') ? 'used' : statuses.has('failed') ? 'failed' : statuses.has('unavailable') ? 'unavailable' : 'skipped'

  return NextResponse.json({
    ok: true,
    entries,
    note: notes.join('; ').slice(0, 500) || null,
    priceCents: priceAllowed ? priceCents : null,   // employees never receive a price
    priceAllowed,
    ai,
  })
}
