/**
 * Server-side employee authorization for Auto-Sales WRITE actions (defense-in-depth). The middleware
 * (proxy.ts) is the primary gate — it already blocks unauthorized POSTs to /auto-sales/* (which is
 * where server actions post) and to /api/auto-sales/*. This re-check inside the actions guarantees a
 * mutation can never run without a valid employee session OR admin Basic-Auth, even if a matcher is
 * later changed. Node-only (uses next/headers); never imported by the Edge middleware.
 */
import { cookies, headers } from 'next/headers'
import { EMP_COOKIE, employeePinConfigured, verifyEmployeeToken } from './session'

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
