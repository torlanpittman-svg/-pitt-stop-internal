/**
 * Employee Auto-Sales session — a signed, httpOnly cookie establishing that a shop device entered the
 * 4-digit EMPLOYEE_PIN. EDGE + NODE safe (Web Crypto only; no node:crypto / next-headers) so the SAME
 * verify runs in middleware (Edge) and in server actions/routes (Node). Signing secret reuses the
 * existing convention (IDENTITY_SECRET || ADMIN_PASSWORD) — see apps/workflow/identity.ts.
 *
 * Employee PIN ≠ admin auth: this session unlocks ONLY the /auto-sales employee surface. /admin/* stays
 * behind ADMIN_PASSWORD (proxy.ts) and is NEVER unlocked by this cookie. The PIN itself is never in the
 * cookie, client source, logs, URLs, or responses — only a signed {exp} token is.
 */
export const EMP_COOKIE = 'ps_emp'

export function employeePinConfigured(): boolean { return !!process.env.EMPLOYEE_PIN && /^\d{4,8}$/.test(process.env.EMPLOYEE_PIN) }
export function getEmployeePin(): string | null { return process.env.EMPLOYEE_PIN ?? null }
export function employeeSessionMaxAgeSeconds(): number {
  const h = parseInt(process.env.EMPLOYEE_SESSION_HOURS || '12', 10)
  return (Number.isFinite(h) && h > 0 ? h : 12) * 3600
}
function sessionSecret(): string { return process.env.IDENTITY_SECRET || process.env.ADMIN_PASSWORD || 'pittstop-dev-secret' }

// ── base64url helpers (small payloads only) ──
const enc = new TextEncoder()
function b64url(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function fromB64url(s: string): Uint8Array { const t = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
async function hmacKey(): Promise<CryptoKey> { return crypto.subtle.importKey('raw', enc.encode(sessionSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) }

/** Create a signed session token valid for maxAgeSeconds (defaults to the configured window). */
export async function signEmployeeSession(maxAgeSeconds = employeeSessionMaxAgeSeconds()): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ exp: Date.now() + maxAgeSeconds * 1000 })))
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body) as BufferSource)))
  return `${body}.${sig}`
}
/** Verify a session token → its payload, or null if bad signature / expired / malformed. */
export async function verifyEmployeeToken(token: string | undefined | null): Promise<{ exp: number } | null> {
  if (!token || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  let ok = false
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(), fromB64url(sig) as BufferSource, enc.encode(body) as BufferSource) } catch { return null }
  if (!ok) return null
  try { const p = JSON.parse(new TextDecoder().decode(fromB64url(body))); return p && typeof p.exp === 'number' && p.exp >= Date.now() ? p : null } catch { return null }
}
