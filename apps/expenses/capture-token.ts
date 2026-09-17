/**
 * Business Receipts — capture (filing) capability token.
 *
 * A short-lived, HMAC-signed token the upload route hands back to WHOEVER just uploaded a receipt. It is a
 * CAPABILITY bound to that ONE receipt id: presenting it later proves "I am the uploader of this specific
 * receipt" and authorizes finalizing (filing) it — WITHOUT granting the ability to edit arbitrary receipt
 * ids. This is the "equivalent secure submission mechanism" for the employee self-filing flow: it works for
 * a named individual AND a shared-PIN device (which has no stable identity key), and it never widens access
 * to another employee's receipts or to raw AI output.
 *
 * It is NOT authentication (the file action still requires a verified session and fails closed on anonymous)
 * and NOT authorization to approve — only to FILE the specific receipt it was minted for. Signed with the
 * existing shop-session secret convention (IDENTITY_SECRET || ADMIN_PASSWORD). Node-only (node:crypto).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000 // 6h — comfortably covers a capture session; not long-lived.

function secret(): string { return process.env.IDENTITY_SECRET || process.env.ADMIN_PASSWORD || 'pittstop-dev-secret' }
function b64url(b: Buffer): string { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function sign(payload: string): string { return b64url(createHmac('sha256', secret()).update(payload).digest()) }

/** Mint a capture token authorizing the filing of exactly `receiptId`, valid for `ttlMs`. */
export function signCaptureToken(receiptId: string, ttlMs: number = DEFAULT_TTL_MS): string {
  const exp = Date.now() + ttlMs
  const body = `${receiptId}.${exp}`
  return `${exp}.${sign(body)}`
}

/** True iff `token` is a currently-valid capture token minted for `receiptId`. Constant-time compare;
 *  fails closed on any malformed/expired/mismatched input. */
export function verifyCaptureToken(token: string | null | undefined, receiptId: string): boolean {
  if (!token || !receiptId || typeof token !== 'string') return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const exp = Number(token.slice(0, dot))
  const sig = token.slice(dot + 1)
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false
  const expected = sign(`${receiptId}.${exp}`)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
