/**
 * Business Receipts — authorization (FAIL-CLOSED, receipt-scoped).
 *
 * The shared guards `authorizedManager()` / `employeeAuthorized*()` deliberately DEV-OPEN when no PIN is
 * configured (`!employeeAuthConfigured()` → allow), which is fine for the other shop tools but is NOT
 * acceptable for financial receipt capture/approval. These wrappers require a SERVER-VERIFIED identity
 * regardless of configuration, so an anonymous caller is rejected even when credentials are unset. They
 * reuse the existing signed-session primitives and NEVER modify the shared manager/identity config.
 *
 *  - receiptManager()* → a verified manager/admin, or null. (approve/reject/reopen/retry/review + queue)
 *  - receiptUploader()* → any verified session (named individual, admin, or a valid shared-PIN device),
 *    with an attribution label. Rejects anonymous. (capture/upload)
 */
import { cookies } from 'next/headers'
import { EMP_COOKIE, verifyEmployeeToken, type AuthedActor } from '@/apps/auth/employee-session'
import { authenticatedActor, authenticatedActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { verifyCaptureToken } from './capture-token'

export interface Uploader { actor: AuthedActor | null; name: string }

function cookieFromHeader(header: string | null, name: string): string | null {
  if (!header) return null
  for (const p of header.split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === name) return p.slice(i + 1).trim() }
  return null
}

/** Verified manager/admin for a server component or action, or null. Never dev-opens. */
export async function receiptManager(): Promise<AuthedActor | null> {
  const a = await authenticatedActor()
  return a && isManagerRole(a.role) ? a : null
}

/** Verified manager/admin for a route handler (has the Request), or null. Never dev-opens. */
export async function receiptManagerFromRequest(req: Request): Promise<AuthedActor | null> {
  const a = await authenticatedActorFromRequest(req)
  return a && isManagerRole(a.role) ? a : null
}

/** A verified uploader (named person, admin, or a valid shared-PIN device), or null when anonymous. */
export async function receiptUploader(): Promise<Uploader | null> {
  const named = await authenticatedActor()
  if (named) return { actor: named, name: named.name }
  const tok = (await cookies()).get(EMP_COOKIE)?.value
  if (await verifyEmployeeToken(tok)) return { actor: null, name: 'Shop device' }
  return null
}

/** Route-handler variant of {@link receiptUploader}. Fails closed on an anonymous/unauthenticated request. */
export async function receiptUploaderFromRequest(req: Request): Promise<Uploader | null> {
  const named = await authenticatedActorFromRequest(req)
  if (named) return { actor: named, name: named.name }
  const tok = cookieFromHeader(req.headers.get('cookie'), EMP_COOKIE)
  if (await verifyEmployeeToken(tok)) return { actor: null, name: 'Shop device' }
  return null
}

/**
 * May THIS actor finalize (file) THIS receipt? Fail-closed authorization for employee self-filing, enforced
 * independently of the UI. A caller must have a verified session (checked by the action) AND satisfy one of:
 *   - manager/admin role — full authority (resolving exceptions, correcting anything); OR
 *   - a valid signed CAPTURE TOKEN minted for this receipt id (proves they uploaded it this session — the
 *     path a shared-PIN device or a named employee uses right after capture); OR
 *   - their server-verified identity key matches the receipt's uploaded_by_key (a named uploader).
 * An employee without any of these cannot touch an arbitrary receipt id.
 */
export function canFileReceipt(
  actor: AuthedActor | null,
  row: { uploadedByKey: string | null; id: string },
  captureToken: string | null | undefined,
): boolean {
  if (actor && isManagerRole(actor.role)) return true
  if (verifyCaptureToken(captureToken, row.id)) return true
  if (actor?.key && row.uploadedByKey && actor.key === row.uploadedByKey) return true
  return false
}
