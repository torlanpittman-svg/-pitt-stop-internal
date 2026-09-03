/**
 * POST /api/quick-entry/interpret  { text }
 * Turns free text into structured suggestions that merge into the SAME Quick Entry
 * lines. Deterministic core owns the price + exact catalog/alias matches; a constrained
 * AI pass classifies the remainder (semantic catalog match / custom work / internal
 * note). The server re-validates every AI result against the real catalog, caps custom
 * text, and only returns a price to a manager/admin. Never writes anything.
 */
import { NextResponse } from 'next/server'
import { authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { getFullCatalog } from '@/apps/quick-entry/db'
import { nlEnabled } from '@/apps/settings/db'
import { deterministicInterpret, norm, type CatalogService, type RecognizedService } from '@/apps/quick-entry/interpret'
import { classifyUnmatched, aiConfigured } from '@/apps/quick-entry/interpret-ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Bubble label overrides (mirror the Quick Entry menu) so an NL "wax"/"polish" resolves
// to the SAME title as the bubble and dedupes correctly.
const LABEL: Record<string, string> = { paint_correction_1step: 'Polish', exterior_wax: 'Wax' }

export async function POST(req: Request) {
  if (!(await nlEnabled())) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 })
  const actor = await authenticatedActorFromRequest(req)
  const priceAllowed = actor?.role === 'manager' || actor?.role === 'admin'

  const body = await req.json().catch(() => ({})) as { text?: string }
  const text = (body.text ?? '').slice(0, 2000)
  if (!text.trim()) return NextResponse.json({ ok: true, services: [], note: null, priceCents: null, priceAllowed })

  // Retail catalog (exclude dealer services) with bubble labels applied.
  const full = await getFullCatalog()
  const services: CatalogService[] = full
    .filter((f) => f.item.active && f.item.source !== 'dealer_rules' && !f.item.slug.startsWith('dealer_'))
    .map((f) => {
      const title = LABEL[f.item.slug] ?? f.item.name
      return { catalogId: f.item.id, title, terms: [norm(title), norm(f.item.name), ...f.aliases.map((a) => norm(a.alias))] }
    })

  const det = deterministicInterpret(text, services)
  const ai = await classifyUnmatched(det.unmatched, services.map((s) => s.title))

  const out: RecognizedService[] = []
  const seen = new Set<string>()
  const push = (r: RecognizedService) => { const k = norm(r.title); if (k && !seen.has(k)) { seen.add(k); out.push(r) } }
  det.recognized.forEach(push)

  const notes: string[] = []
  for (const c of ai) {
    if (c.type === 'service' && c.catalogTitle) {
      const svc = services.find((s) => norm(s.title) === norm(c.catalogTitle!))   // validate against the real catalog
      if (svc) push({ title: svc.title, catalogId: svc.catalogId, source: 'semantic' })
      else push({ title: c.phrase.slice(0, 120), catalogId: null, source: 'custom' })   // hallucinated title → custom
    } else if (c.type === 'note') {
      const n = (c.noteText || c.phrase).trim().slice(0, 200); if (n) notes.push(n)
    } else {
      push({ title: c.phrase.slice(0, 120), catalogId: null, source: 'custom' })
    }
  }

  return NextResponse.json({
    ok: true,
    services: out,
    note: notes.join('; ').slice(0, 500) || null,
    priceCents: priceAllowed ? det.priceCents : null,   // employees never receive a price
    priceAllowed,
    aiUsed: aiConfigured(),
  })
}
