/**
 * Shared authorization + request hygiene for the parts-import routes. Not a route handler (underscore
 * prefix) — just helpers. The gate re-verifies inside each handler (defense-in-depth over proxy.ts): a VALID
 * shop session AND partsVisibleFor() AND the PARTS_SCREENSHOT_IMPORT_ENABLED flag.
 *
 * EQUAL PERMISSIONS (owner correction): every authorized shop user — manager/admin, individual employee, or
 * a legacy shared-PIN session — gets the SAME import capability (upload, read, view costs + originals,
 * review, link/skip/new, acknowledge duplicates, mark ordered, save, cancel). There is no manager handoff.
 * This does NOT widen roles or any other permission (Invoice Draft / QB / checks / finance / the manual
 * tracker's billing-sell-credit gates are untouched); it only governs this screenshot-import workflow.
 */
import { NextResponse } from 'next/server'
import { employeeAuthorizedFromRequest, shopActorFromRequest } from '@/apps/auth/employee-guard'
import { partsVisibleFor, partsScreenshotImportEnabled } from '@/apps/parts/visibility'

export interface Gated { actorName: string; actorKey: string | null }

export async function importGate(req: Request): Promise<Gated | { response: NextResponse }> {
  if (!(await employeeAuthorizedFromRequest(req))) return { response: NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 }) }
  if (!partsScreenshotImportEnabled()) return { response: NextResponse.json({ ok: false, error: 'Screenshot import is not enabled.', enabled: false }, { status: 403 }) }
  // With the import flag on, Parts is visible to any authorized shop user (partsVisibleFor reflects that);
  // this guard is kept as defense-in-depth and stays satisfied for an authorized session.
  if (!partsVisibleFor(false)) return { response: NextResponse.json({ ok: false, error: 'Parts are not available yet.' }, { status: 403 }) }
  // Generic attribution for a resolved identity, else 'Employee' for an anonymous shared-PIN device. Never a
  // fabricated manager flag — the import capability is identical for everyone, so no role is surfaced here.
  const actor = await shopActorFromRequest(req)
  return { actorName: actor?.name ?? 'Employee', actorKey: actor?.key ?? null }
}

export const isUuid = (s: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)

/** Reject a cross-site mutation: when an Origin header is present it must match the request host. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true // non-browser / same-origin fetches may omit Origin
  try {
    const host = req.headers.get('host')
    return !!host && new URL(origin).host === host
  } catch {
    return false
  }
}
