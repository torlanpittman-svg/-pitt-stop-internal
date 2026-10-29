/**
 * Shared authorization + request hygiene for the parts-import routes. Not a route handler (underscore
 * prefix) — just helpers. The gate re-verifies inside each handler (defense-in-depth over proxy.ts): a VALID
 * employee session AND partsVisibleFor() AND the PARTS_SCREENSHOT_IMPORT_ENABLED flag.
 */
import { NextResponse } from 'next/server'
import { employeeAuthorizedFromRequest, shopActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { partsVisibleFor, partsScreenshotImportEnabled } from '@/apps/parts/visibility'

export interface Gated { manager: boolean; actorName: string; actorKey: string | null }

export async function importGate(req: Request): Promise<Gated | { response: NextResponse }> {
  if (!(await employeeAuthorizedFromRequest(req))) return { response: NextResponse.json({ ok: false, error: 'Sign in required' }, { status: 401 }) }
  const actor = await shopActorFromRequest(req)
  const manager = isManagerRole(actor?.role)
  if (!partsVisibleFor(manager)) return { response: NextResponse.json({ ok: false, error: 'Parts are not available yet.' }, { status: 403 }) }
  if (!partsScreenshotImportEnabled()) return { response: NextResponse.json({ ok: false, error: 'Screenshot import is not enabled.', enabled: false }, { status: 403 }) }
  return { manager, actorName: actor?.name ?? 'Employee', actorKey: actor?.key ?? null }
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
