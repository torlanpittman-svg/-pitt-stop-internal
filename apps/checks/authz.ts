/**
 * Authorization for Write-a-Check. Only operational MANAGERS (Darryl / Tony / Torlan — role 'manager')
 * and admin may write/print checks; ordinary employees are denied any financial-write capability. Reuses
 * the existing signed-identity model (authenticatedActorFromRequest) — no new auth system, no
 * ADMIN_PASSWORD requirement. This is defense-in-depth: proxy.ts already gates the surface.
 */
import { authenticatedActorFromRequest, authenticatedActor } from '@/apps/auth/employee-guard'
import type { AuthedActor } from '@/apps/auth/employee-session'

export function isManagerRole(role: string | undefined | null): boolean {
  return role === 'manager' || role === 'admin'
}

/** Actor from a Request if they are a manager/admin, else null. */
export async function managerFromRequest(req: Request): Promise<AuthedActor | null> {
  const actor = await authenticatedActorFromRequest(req)
  return actor && isManagerRole(actor.role) ? actor : null
}

/** next/headers variant for server components / actions. */
export async function managerActor(): Promise<AuthedActor | null> {
  const actor = await authenticatedActor()
  return actor && isManagerRole(actor.role) ? actor : null
}
