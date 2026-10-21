/**
 * Public booking contact rules — PURE, shared by the browser (inline feedback) and the server (authoritative).
 * These check FORMAT only. A well-formed phone number or email does not prove the customer owns it, and the
 * UI never says it does.
 */

export interface ContactFields { firstName: string; lastName: string; phone: string; email: string }
export type ContactErrors = Partial<Record<keyof ContactFields, string>>

/** US 10-digit number (an optional leading 1 is accepted); area code and exchange cannot start with 0 or 1. */
export function phoneDigits(raw: string): string {
  return (raw ?? '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1')
}
export function isValidUsPhone(raw: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(phoneDigits(raw))
}
/** (979) 555-0123 display form for a valid number; anything else is returned trimmed. */
export function formatUsPhone(raw: string): string {
  const d = phoneDigits(raw)
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (raw ?? '').trim()
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/
export const isValidEmail = (raw: string) => {
  const e = (raw ?? '').trim()
  return e.length <= 240 && EMAIL.test(e)
}

export function validateContact(c: ContactFields): ContactErrors {
  const errors: ContactErrors = {}
  if (!c.firstName?.trim()) errors.firstName = 'Enter your first name.'
  else if (c.firstName.trim().length > 120) errors.firstName = 'First name is too long.'
  if (!c.lastName?.trim()) errors.lastName = 'Enter your last name.'
  else if (c.lastName.trim().length > 120) errors.lastName = 'Last name is too long.'
  if (!c.phone?.trim()) errors.phone = 'Enter your phone number.'
  else if (!isValidUsPhone(c.phone)) errors.phone = 'Enter a 10-digit US phone number, like (979) 555-0123.'
  if (!c.email?.trim()) errors.email = 'Enter your email address.'
  else if (!isValidEmail(c.email)) errors.email = 'Enter an email address like name@example.com.'
  return errors
}
