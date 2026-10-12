/**
 * /api/admin/checks/specimen — OWNER tool for bank MICR validation. ADMIN ONLY, twice over: proxy.ts
 * gates /api/admin/checks/* on ADMIN_PASSWORD, and this handler itself accepts only the admin identity
 * (a manager PIN session is refused even if the proxy rule were ever changed). Responses are no-store.
 *   GET  — whether a specimen can be printed (bank numbers + font; masks/booleans only).
 *   POST — send ONE non-negotiable VOID specimen carrying the real MICR line (check number 000000) to the
 *          shop printer. No check record, no QuickBooks transaction, no check number taken. Requires the
 *          exact confirmation phrase so it cannot be triggered by accident.
 *
 * Body: { confirm: 'PRINT BANK SPECIMEN' }
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { enqueueBankSpecimen, CheckValidationError } from '@/apps/checks/service'
import { specimenReadiness } from '@/apps/checks/micr'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONFIRM = 'PRINT BANK SPECIMEN'
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/** The ADMIN identity only — never a manager session. */
async function adminFromRequest(req: Request) {
  const actor = await managerFromRequest(req)
  return actor?.role === 'admin' ? actor : null
}

export async function GET(req: Request) {
  if (!(await adminFromRequest(req))) return json({ error: 'forbidden' }, 403)
  return json({ specimen: specimenReadiness(), confirm: CONFIRM })
}

export async function POST(req: Request) {
  const actor = await adminFromRequest(req)
  if (!actor) return json({ error: 'forbidden' }, 403)
  let body: { confirm?: string } = {}
  try { body = await req.json() } catch { /* handled below */ }
  if (body.confirm !== CONFIRM) return json({ error: 'confirmation_required', message: `Send { "confirm": "${CONFIRM}" } to print a specimen.` }, 400)
  try {
    return json({ ok: true, ...(await enqueueBankSpecimen({ key: actor.key, name: actor.name })) })
  } catch (e) {
    if (e instanceof CheckValidationError) return json({ error: e.code, message: e.message }, 409)
    return json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, 500)
  }
}
