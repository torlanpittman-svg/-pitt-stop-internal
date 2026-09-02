/**
 * Employee shop session — the ONE shared employee-auth implementation for Pitt Stop OS.
 *
 * A signed, httpOnly cookie establishing WHO entered a valid PIN on a shop device. It gates the
 * employee operational tools (Auto Sales, Work Board, Check In, Quick Entry, Dealer Check-In) and
 * their AI/mutation APIs, AND — because it is HMAC-signed — it is the server-verified source of truth
 * for identity + role (the individual signed in). EDGE + NODE safe (Web Crypto only; no node:crypto /
 * next-headers) so the SAME verify runs in middleware (Edge) and in server routes/actions (Node).
 * Signing secret reuses the existing convention (IDENTITY_SECRET || ADMIN_PASSWORD).
 *
 * Identity model: each individual has a PIN stored ONLY in a server-side env var (never committed);
 * the non-secret name/role metadata lives in EMPLOYEE_IDENTITIES below. A correct PIN mints a session
 * carrying signed {k,n,r} (key, name, role) claims. Because those claims are signed they cannot be
 * spoofed by a client — role authorization reads them, not a client-writable cookie.
 *
 * Employee PIN ≠ admin auth: this session NEVER unlocks /admin/* (that stays behind ADMIN_PASSWORD in
 * proxy.ts) and 'manager' is never 'admin'. A PIN is never in the cookie, client source, logs, URLs,
 * or responses — only a signed token is.
 */
export const EMP_COOKIE = 'ps_emp'

export type EmployeeRole = 'employee' | 'manager' | 'admin'
export interface AuthedActor { key: string; name: string; role: EmployeeRole }

/**
 * Non-secret identity registry. Names + roles are safe to commit; the actual PIN for each person lives
 * ONLY in the referenced env var (pinEnv), set locally in .env.local and in the production environment.
 */
export const EMPLOYEE_IDENTITIES: ReadonlyArray<{ key: string; name: string; role: EmployeeRole; pinEnv: string }> = [
  { key: 'darryl', name: 'Darryl', role: 'employee', pinEnv: 'PIN_DARRYL' },
  { key: 'tony',   name: 'Tony',   role: 'employee', pinEnv: 'PIN_TONY' },
  { key: 'torlan', name: 'Torlan', role: 'manager',  pinEnv: 'PIN_TORLAN' },
]

const PIN_RE = /^\d{4,8}$/

/** Any individual PIN configured? */
export function identityPinsConfigured(): boolean {
  return EMPLOYEE_IDENTITIES.some((i) => { const v = process.env[i.pinEnv]; return !!v && PIN_RE.test(v) })
}
/** Legacy shared shop PIN still set? */
export function employeePinConfigured(): boolean { return !!process.env.EMPLOYEE_PIN && PIN_RE.test(process.env.EMPLOYEE_PIN) }
/** Is the employee gate active at all (individual identities OR the legacy shared PIN)? */
export function employeeAuthConfigured(): boolean { return identityPinsConfigured() || employeePinConfigured() }

export function getEmployeePin(): string | null { return process.env.EMPLOYEE_PIN ?? null }
export function employeeSessionMaxAgeSeconds(): number {
  const h = parseInt(process.env.EMPLOYEE_SESSION_HOURS || '12', 10)
  return (Number.isFinite(h) && h > 0 ? h : 12) * 3600
}
function sessionSecret(): string { return process.env.IDENTITY_SECRET || process.env.ADMIN_PASSWORD || 'pittstop-dev-secret' }

/**
 * Constant-time-ish match of an entered PIN against each configured individual PIN → that identity, or
 * null. Compares against EVERY configured identity (no early return) so timing does not reveal which,
 * if any, prefix matched. Runs server-side only (login route). The PIN is never returned or logged.
 */
export function resolveIdentityByPin(pin: string): AuthedActor | null {
  if (!PIN_RE.test(pin)) return null
  let match: AuthedActor | null = null
  for (const id of EMPLOYEE_IDENTITIES) {
    const expected = process.env[id.pinEnv]
    if (expected && PIN_RE.test(expected) && timingEqual(pin, expected)) {
      match = { key: id.key, name: id.name, role: id.role }
    }
  }
  return match
}

/** Length-independent constant-time string compare (Web Crypto safe; no node:crypto). */
function timingEqual(a: string, b: string): boolean {
  const ab = enc.encode(a), bb = enc.encode(b)
  const len = Math.max(ab.length, bb.length)
  let diff = ab.length ^ bb.length
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

// ── base64url helpers (small payloads only) ──
const enc = new TextEncoder()
function b64url(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function fromB64url(s: string): Uint8Array { const t = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
async function hmacKey(): Promise<CryptoKey> { return crypto.subtle.importKey('raw', enc.encode(sessionSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) }

export interface EmployeeTokenPayload { exp: number; k?: string; n?: string; r?: EmployeeRole }

/**
 * Create a signed session token valid for maxAgeSeconds. When `actor` is provided its {key,name,role}
 * are embedded as signed claims (k,n,r); an anonymous session (legacy shared PIN) omits them.
 */
export async function signEmployeeSession(actor?: AuthedActor | null, maxAgeSeconds = employeeSessionMaxAgeSeconds()): Promise<string> {
  const payload: EmployeeTokenPayload = { exp: Date.now() + maxAgeSeconds * 1000 }
  if (actor) { payload.k = actor.key; payload.n = actor.name; payload.r = actor.role }
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body) as BufferSource)))
  return `${body}.${sig}`
}
/** Verify a session token → its payload, or null if bad signature / expired / malformed. */
export async function verifyEmployeeToken(token: string | undefined | null): Promise<EmployeeTokenPayload | null> {
  if (!token || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  let ok = false
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(), fromB64url(sig) as BufferSource, enc.encode(body) as BufferSource) } catch { return null }
  if (!ok) return null
  try { const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as EmployeeTokenPayload; return p && typeof p.exp === 'number' && p.exp >= Date.now() ? p : null } catch { return null }
}
/** Extract the signed identity from a verified payload (null for an anonymous/legacy session). */
export function authedActorFromToken(payload: EmployeeTokenPayload | null | undefined): AuthedActor | null {
  if (!payload || !payload.k || !payload.n || !payload.r) return null
  return { key: payload.k, name: payload.n, role: payload.r }
}
