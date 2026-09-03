/**
 * Server-side employee authorization + authenticated identity for shop routes/actions.
 *
 * proxy.ts is the PRIMARY gate — it blocks unauthorized requests to the employee tool paths and their
 * APIs. The `employeeAuthorized*` checks re-verify inside handlers/actions (defense-in-depth) so an AI
 * call or write can never run without a valid employee session OR admin Basic-Auth.
 *
 * `authenticatedActor*` returns WHO is signed in (server-verified from the signed ps_emp claims) and is
 * the authoritative source for role authorization + audit attribution. It NEVER trusts a client-writable
 * cookie/body. Admin Basic-Auth (ADMIN_PASSWORD) resolves to an { role: 'admin' } actor. Node-only (uses
 * next/headers for the no-arg variants); never imported by the Edge middleware.
 */
import { cookies, headers } from 'next/headers'
import {
  EMP_COOKIE, employeeAuthConfigured, verifyEmployeeToken, authedActorFromToken, type AuthedActor,
} from './employee-session'

function adminBasicOk(auth: string | null): boolean {
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminPassword || !auth?.startsWith('Basic ')) return false
  try { const c = atob(auth.slice(6)); return c.slice(c.indexOf(':') + 1).trim() === adminPassword.trim() } catch { return false }
}

function tokenFromCookieHeader(cookie: string): string | null {
  for (const p of cookie.split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === EMP_COOKIE) return p.slice(i + 1).trim() }
  return null
}

export async function employeeAuthorized(): Promise<boolean> {
  if (!employeeAuthConfigured()) return true // no PIN configured = open (dev), matches middleware
  if (adminBasicOk((await headers()).get('authorization'))) return true
  const tok = (await cookies()).get(EMP_COOKIE)?.value
  return !!(await verifyEmployeeToken(tok))
}

/** Request-based variant for route handlers that have the Request object (no next/headers needed). */
export async function employeeAuthorizedFromRequest(req: Request): Promise<boolean> {
  if (!employeeAuthConfigured()) return true
  if (adminBasicOk(req.headers.get('authorization'))) return true
  return !!(await verifyEmployeeToken(tokenFromCookieHeader(req.headers.get('cookie') || '')))
}

const ADMIN_ACTOR: AuthedActor = { key: 'admin', name: 'Admin', role: 'admin' }

/**
 * The authenticated identity for a request — the SINGLE source of truth for role checks + attribution.
 * Priority: valid admin Basic-Auth → admin actor; else the signed ps_emp identity claims; else null
 * (anonymous/legacy session or unauthenticated). Never reads a client-writable cookie/body.
 */
export async function authenticatedActorFromRequest(req: Request): Promise<AuthedActor | null> {
  if (adminBasicOk(req.headers.get('authorization'))) return ADMIN_ACTOR
  const payload = await verifyEmployeeToken(tokenFromCookieHeader(req.headers.get('cookie') || ''))
  return authedActorFromToken(payload)
}

/** next/headers variant for server components / actions. */
export async function authenticatedActor(): Promise<AuthedActor | null> {
  if (adminBasicOk((await headers()).get('authorization'))) return ADMIN_ACTOR
  const payload = await verifyEmployeeToken((await cookies()).get(EMP_COOKIE)?.value)
  return authedActorFromToken(payload)
}
