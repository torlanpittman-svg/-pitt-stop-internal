/**
 * Server-side employee authorization for shop mutation/AI routes + actions (defense-in-depth).
 *
 * proxy.ts is the PRIMARY gate — it already blocks unauthorized requests to the employee tool paths
 * (Auto Sales, Work Board, Check In, Quick Entry, Dealer Check-In) and their APIs. This re-check inside
 * the handlers/actions guarantees an AI call or a write can never run without a valid employee session
 * OR admin Basic-Auth, even if a matcher is later changed. Node-only (uses next/headers); never imported
 * by the Edge middleware.
 */
import { cookies, headers } from 'next/headers'
import { EMP_COOKIE, employeePinConfigured, verifyEmployeeToken } from './employee-session'

export async function employeeAuthorized(): Promise<boolean> {
  if (!employeePinConfigured()) return true // no PIN configured = open (dev), matches middleware
  const adminPassword = process.env.ADMIN_PASSWORD
  const auth = (await headers()).get('authorization')
  if (adminPassword && auth?.startsWith('Basic ')) {
    try { const c = atob(auth.slice(6)); if (c.slice(c.indexOf(':') + 1).trim() === adminPassword.trim()) return true } catch { /* ignore */ }
  }
  const tok = (await cookies()).get(EMP_COOKIE)?.value
  return !!(await verifyEmployeeToken(tok))
}

/** Request-based variant for route handlers that have the Request object (no next/headers needed). */
export async function employeeAuthorizedFromRequest(req: Request): Promise<boolean> {
  if (!employeePinConfigured()) return true
  const adminPassword = process.env.ADMIN_PASSWORD
  const auth = req.headers.get('authorization')
  if (adminPassword && auth?.startsWith('Basic ')) {
    try { const c = atob(auth.slice(6)); if (c.slice(c.indexOf(':') + 1).trim() === adminPassword.trim()) return true } catch { /* ignore */ }
  }
  const cookie = req.headers.get('cookie') || ''
  let token: string | null = null
  for (const p of cookie.split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === EMP_COOKIE) { token = p.slice(i + 1).trim(); break } }
  return !!(await verifyEmployeeToken(token))
}
