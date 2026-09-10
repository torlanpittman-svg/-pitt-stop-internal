/**
 * Authentication for the print BRIDGE endpoints. The bridge is a machine (Raspberry Pi / mini PC / the
 * MacBook today), not a person, so it authenticates with a single shared secret in the Authorization
 * header: `Bearer <PRINT_BRIDGE_TOKEN>`. FAIL CLOSED — if the token env var is unset, every bridge call
 * is rejected (no unauthenticated print endpoint ever). Compared in constant time. The token is never
 * logged or returned.
 */
import crypto from 'node:crypto'

export function bridgeAuthConfigured(): boolean {
  const t = process.env.PRINT_BRIDGE_TOKEN
  return !!t && t.length >= 16
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    crypto.timingSafeEqual(ab, ab)
    return false
  }
  return crypto.timingSafeEqual(ab, bb)
}

/** True when the request carries the valid bridge bearer token. */
export function bridgeAuthorized(req: Request): boolean {
  const expected = process.env.PRINT_BRIDGE_TOKEN
  if (!expected || expected.length < 16) return false // fail closed
  const auth = req.headers.get('authorization') || ''
  if (!auth.startsWith('Bearer ')) return false
  return timingSafeEqual(auth.slice(7).trim(), expected.trim())
}
