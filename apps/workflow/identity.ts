/**
 * Phase 1 identity — lightweight, shop-friendly. No enterprise auth.
 *
 * • Active employee: a readable cookie `ps_actor` = {id,name,role} (attribution +
 *   client display). Server reads it to attribute writes (who did what).
 * • Manager elevation: a signed, httpOnly cookie `ps_elev` = {employeeId,role,exp}.
 *   Managers/admins PIN-elevate for a short TTL (default 10 min); UI shows a
 *   "Manager mode — Lock" badge; Lock clears it; expiry re-hides manager sections.
 * • Admin AREA (/admin/*) is NOT unlocked by a device PIN — it stays behind the
 *   existing ADMIN_PASSWORD (proxy.ts). Roles here are for attribution + app-side
 *   visibility only.
 *
 * Pure functions (node:crypto only) so they're unit-testable without a browser/DB.
 */
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto'

export type Role = 'employee' | 'manager' | 'admin'
export interface Actor { id: string; name: string; role: Role }
export interface Elevation { employeeId: string; role: Role; exp: number }

// ── Feature flags / config ──────────────────────────────────────────────────
export function identityEnabled(): boolean { return process.env.IDENTITY_ENABLED === 'true' }
export function switchRequiresPin(): boolean { return process.env.SWITCH_REQUIRES_PIN === 'true' }
export function elevationMinutes(): number {
  const n = parseInt(process.env.MANAGER_ELEVATION_MINUTES || '10', 10)
  return Number.isFinite(n) && n > 0 ? n : 10
}
function secret(): string { return process.env.IDENTITY_SECRET || process.env.ADMIN_PASSWORD || 'pittstop-dev-secret' }

// ── PIN hashing (scrypt) ─────────────────────────────────────────────────────
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex')
  const dk = scryptSync(String(pin), salt, 32).toString('hex')
  return `scrypt$${salt}$${dk}`
}
export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, salt, dk] = parts
  const calc = scryptSync(String(pin), salt, 32)
  const exp = Buffer.from(dk, 'hex')
  return calc.length === exp.length && timingSafeEqual(calc, exp)
}

// ── Signed elevation token ───────────────────────────────────────────────────
export function signElevation(payload: Elevation): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret()).update(body).digest('base64url')
  return `${body}.${sig}`
}
export function verifyElevation(token: string | undefined | null, now: number = Date.now()): Elevation | null {
  if (!token || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expSig = createHmac('sha256', secret()).update(body).digest('base64url')
  const a = Buffer.from(sig), b = Buffer.from(expSig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as Elevation
    if (!p || typeof p.exp !== 'number' || p.exp < now) return null
    return p
  } catch { return null }
}

// ── Cookie parsing (from a raw Cookie header) ────────────────────────────────
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}
/** Parse an actor from a raw cookie value (for server components using next/headers). */
export function parseActor(value: string | null | undefined): Actor | null {
  if (!value) return null
  try {
    const a = JSON.parse(value)
    if (a && typeof a.name === 'string' && a.name) return { id: String(a.id ?? ''), name: a.name, role: (a.role ?? 'employee') as Role }
  } catch { /* ignore */ }
  return null
}
export function getActor(cookieHeader: string | null | undefined): Actor | null {
  return parseActor(readCookie(cookieHeader, 'ps_actor'))
}
export function getElevation(cookieHeader: string | null | undefined, now: number = Date.now()): Elevation | null {
  return verifyElevation(readCookie(cookieHeader, 'ps_elev'), now)
}

const RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2 }

/** The remembered employee's base role (permanent on the device, no PIN). */
export function baseRole(actor: Actor | null): Role { return actor?.role ?? 'employee' }

/**
 * Effective role = the remembered employee's BASE role, which is always available
 * (no PIN, never expires). A temporary elevation can only RAISE the role above base
 * (same person) for step-up scenarios; when it expires it drops back to base — it
 * NEVER downgrades a Manager/Admin to Employee. Elevation only removes above-base
 * privileges, never the person's normal role.
 */
export function effectiveRole(actor: Actor | null, elevation: Elevation | null): Role {
  const base = baseRole(actor)
  if (actor && elevation && elevation.employeeId === actor.id && RANK[elevation.role] > RANK[base]) {
    return elevation.role
  }
  return base
}
