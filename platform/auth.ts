/**
 * Validates HTTP Basic Auth against the ADMIN_PASSWORD env var.
 * If ADMIN_PASSWORD is unset, access is open (suitable for local dev).
 */
export function checkAdminAuth(authHeader: string | null): boolean {
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminPassword) return true

  if (!authHeader?.startsWith('Basic ')) return false

  try {
    const credentials = atob(authHeader.slice(6))
    const colonIdx = credentials.indexOf(':')
    const password = credentials.slice(colonIdx + 1)
    return password === adminPassword
  } catch {
    return false
  }
}
