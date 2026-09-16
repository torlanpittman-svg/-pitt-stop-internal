/**
 * GET /api/search?q=…  — global operational search.
 *
 * Authorization (fail closed, server-side):
 *   1. proxy.ts already gates this path with the employee session.
 *   2. Defence-in-depth: we re-verify the employee session here — an unauthenticated caller gets 401 and
 *      NO results (never a partial leak).
 *   3. The signed identity's ROLE decides the category scope (authz.scopeForRole): ordinary employees
 *      never receive the manager-only financial categories (receipts, checks); managers/admins do.
 *
 * Safety:
 *   - Query length is validated: too long → 400 (abusive/malformed); too short → 200 with empty results.
 *   - Per-category + overall caps bound the response size (assemble.ts).
 *   - Raw queries are NEVER logged (they can contain phone/VIN/customer PII); we log only length + counts.
 *   - All SQL is parameterised — injection-like input is treated purely as data.
 */
import { NextResponse } from 'next/server'
import { employeeAuthorizedFromRequest, authenticatedActorFromRequest } from '@/apps/auth/employee-guard'
import { parseQuery } from '@/apps/search/normalize'
import { scopeForRole } from '@/apps/search/authz'
import { executeSearch } from '@/apps/search/service'
import { logger } from '@/platform/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  // Fail closed: no valid employee session → 401, no results.
  if (!(await employeeAuthorizedFromRequest(req))) {
    return NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 })
  }

  const raw = new URL(req.url).searchParams.get('q') ?? ''
  const parsed = parseQuery(raw)
  if (!parsed.ok) {
    if (parsed.reason === 'too_long') {
      return NextResponse.json({ ok: false, error: 'Search query too long' }, { status: 400 })
    }
    // too_short → normal empty state, not an error.
    return NextResponse.json({ ok: true, query: raw.trim(), groups: [], total: 0, truncated: false })
  }

  // Role → allowed categories. An authorized-but-anonymous (legacy) session is employee-level.
  const actor = await authenticatedActorFromRequest(req)
  const scope = scopeForRole(actor?.role ?? null, true)

  try {
    const response = await executeSearch(parsed.parsed!, scope)
    // Log only non-PII shape (never the raw query — it may contain phone/VIN/customer data).
    logger.info('search', 'query', { len: parsed.parsed!.raw.length, kind: parsed.parsed!.kind, role: actor?.role ?? 'anon', total: response.total })
    return NextResponse.json(response)
  } catch (err) {
    logger.error('search', 'failed', { message: err instanceof Error ? err.message : 'unknown' })
    return NextResponse.json({ ok: false, error: 'Search failed' }, { status: 500 })
  }
}
