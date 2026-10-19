/**
 * Opaque customer appointment links. The link token is an HMAC of the appointment id under a server
 * secret, so it is unguessable, never sequential, and can be re-derived for a retried submission or a
 * reminder email without storing it. Only its SHA-256 hash is stored (appointments.token_hash).
 */
import { createHash, createHmac, randomInt } from 'node:crypto'

function secret(): string {
  const s = process.env.APPOINTMENT_TOKEN_SECRET || process.env.IDENTITY_SECRET
  if (s) return s
  if (process.env.VERCEL_ENV === 'production') throw new Error('APPOINTMENT_TOKEN_SECRET / IDENTITY_SECRET is not configured.')
  return 'pitt-stop-local-dev-appointments'
}

export function appointmentToken(appointmentId: string): string {
  return createHmac('sha256', secret()).update(`appointment:${appointmentId}`).digest('base64url').slice(0, 32)
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export const isTokenShape = (t: string) => /^[A-Za-z0-9_-]{32}$/.test(t)

// No 0/O/1/I/L — readable over the phone.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export function newReference(): string {
  let s = ''
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return `PS-${s}`
}

export function publicBaseUrl(): string {
  return (process.env.BOOKING_PUBLIC_BASE_URL || 'https://pitt-stop-internal.vercel.app').replace(/\/$/, '')
}

export const manageUrl = (appointmentId: string) => `${publicBaseUrl()}/book/a/${appointmentToken(appointmentId)}`
