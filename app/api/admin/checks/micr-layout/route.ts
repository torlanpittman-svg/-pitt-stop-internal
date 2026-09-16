/**
 * /api/admin/checks/micr-layout — the ISOLATED, manager/admin-gated write path for MICR calibration.
 *   GET  — current micr_layout override + effective resolved geometry + standards placement preview +
 *          allowed fields + recent change audit + MICR readiness MASKS (never secrets).
 *   POST — apply a MICR-ONLY coordinate patch. Body: { patch: {<allowed fields>}, reason: string }.
 *          Rejects any non-MICR geometry key or the enable flag; requires an explicit reason; records an
 *          append-only audit row. Writes ONLY micr_layout — never enables MICR, never creates a check /
 *          QuickBooks transaction, never consumes a check number. Negotiable printing stays fail-closed.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { getCheckConfig } from '@/apps/checks/config'
import { micrReadiness } from '@/apps/checks/micr'
import { getMicrLayoutStatus, recentMicrLayoutAudit, updateMicrLayout, MicrConfigError } from '@/apps/checks/micr-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const cfg = await getCheckConfig()
  const status = await getMicrLayoutStatus()
  return NextResponse.json({
    ...status,
    audit: await recentMicrLayoutAudit(),
    micr: micrReadiness(cfg.micrEnabled), // masks only — discloses fail-closed state, never routing/account
  })
}

interface PostBody { patch?: unknown; reason?: string }

export async function POST(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  let body: PostBody
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

  try {
    const result = await updateMicrLayout({ patch: body.patch, reason: String(body.reason ?? ''), actor: actor.name ?? actor.key ?? 'manager' })
    const status = await getMicrLayoutStatus()
    return NextResponse.json({ ok: true, ...result, status, audit: await recentMicrLayoutAudit() })
  } catch (e) {
    if (e instanceof MicrConfigError) return NextResponse.json({ error: e.code, message: e.message }, { status: 400 })
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}
