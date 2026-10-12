/**
 * MICR line generation for NEGOTIABLE checks — the magnetic E-13B line along the bottom of the check.
 *
 * SECURITY MODEL (critical):
 *   - The routing + account numbers are SECRETS. They live ONLY in server-only env vars
 *     MICR_ROUTING / MICR_ACCOUNT (set in Vercel; never in the settings table, never in git, never in
 *     client JS, never logged). This module is the ONLY reader. It exposes just masked previews.
 *   - A real MICR line prints ONLY when ALL are true: micr_enabled=true, MICR_ROUTING+MICR_ACCOUNT set
 *     and valid, and the bundled E-13B font loads intact (micr-font.ts). Otherwise a check is NOT
 *     negotiable and the pipeline refuses to render a real MICR line.
 *   - TEST PRINT / VOID never call this — they draw a clearly-marked non-magnetic placeholder instead.
 *
 * MICR FORMAT: a standard US business check. Every character sits in a fixed POSITION counted from the
 * right edge (see layout.ts) — fields never float with the length of the account or check number:
 *     pos 14      ⑈ closing On-Us symbol            pos 15…  account digits (last digit at 15)
 *     pos 33–43   ⑆ routing(9) ⑆                    pos 44   blank
 *     pos 45      ⑈   pos 46…  check-number digits, then ⑈   (Auxiliary On-Us = the printed check number)
 *   The Amount field (positions 1–12) is encoded by the BANK, never by us. Where the account sits inside
 *   the On-Us field is bank-specific — confirm against the bank's MICR spec / an existing check.
 */
import { MICR_FONT, micrFontAvailable } from './micr-font'

// E-13B control symbols (Unicode) and their glyph letters in the bundled font.
export const E13B = {
  transit: { unicode: '⑆', glyph: MICR_FONT.glyph.transit },
  amount:  { unicode: '⑇', glyph: MICR_FONT.glyph.amount },  // bank-only; we never print it
  onUs:    { unicode: '⑈', glyph: MICR_FONT.glyph.onUs },
  dash:    { unicode: '⑉', glyph: MICR_FONT.glyph.dash },
} as const

/** ANSI positions (from the right edge) that anchor each field. */
export const MICR_POS = { onUsSymbol: 14, onUsMax: 31, transitRight: 33, transitLeft: 43, auxOnUsRight: 45, max: 63 } as const

const digits = (s: string | undefined | null) => (s ?? '').replace(/\D/g, '')

/** ABA routing checksum (9 digits incl. check digit). */
export function isValidRouting(routing: string): boolean {
  const d = digits(routing)
  if (d.length !== 9) return false
  const n = d.split('').map(Number)
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])
  return sum % 10 === 0
}
export function isValidAccount(account: string): boolean {
  const d = digits(account)
  return d.length >= 4 && d.length <= 17
}

/** Mask for safe display/diagnostics — never reveals the full number. */
export const maskTail = (s: string, keep = 4) => { const d = digits(s); return d ? '••••' + d.slice(-keep) : '' }

export interface MicrSecrets { routing: string; account: string }
/** Read the SECRET routing/account from server-only env. Returns null if unset. NEVER logs the values. */
function readSecrets(): MicrSecrets | null {
  const routing = digits(process.env.MICR_ROUTING)
  const account = digits(process.env.MICR_ACCOUNT)
  if (!routing || !account) return null
  return { routing, account }
}

export interface MicrReadiness {
  enabledFlagOn: boolean       // settings micr_enabled (passed in — this module stays DB-free)
  secretsPresent: boolean
  routingValid: boolean
  accountValid: boolean
  fontInstalled: boolean       // the bundled E-13B font loads intact (checksum-verified)
  ready: boolean               // ALL of the above ⇒ a negotiable MICR line may be printed
  routingMask: string
  accountMask: string
}

/** Full readiness report (no secrets leaked — masks only). `enabled` is the micr_enabled setting. */
export function micrReadiness(enabled: boolean): MicrReadiness {
  const s = readSecrets()
  const routingValid = !!s && isValidRouting(s.routing)
  const accountValid = !!s && isValidAccount(s.account)
  const fontInstalled = micrFontAvailable()
  return {
    enabledFlagOn: enabled,
    secretsPresent: !!s,
    routingValid, accountValid, fontInstalled,
    ready: enabled && !!s && routingValid && accountValid && fontInstalled,
    routingMask: s ? maskTail(s.routing) : '',
    accountMask: s ? maskTail(s.account) : '',
  }
}

/** One printed MICR character: `pos` is its ANSI position from the right edge, `ch` its font character. */
export interface MicrCell { pos: number; ch: string }

/**
 * Lay a business-check MICR line onto the fixed position grid. Pure — takes the numbers as arguments so it
 * can be exercised with test data. Throws if a field cannot fit its standard positions (never squeezes).
 */
export function layoutMicrCells(input: { routing: string; account: string; checkNumber: string | number }): MicrCell[] {
  const routing = digits(input.routing), account = digits(input.account), num = digits(String(input.checkNumber))
  if (routing.length !== 9) throw new Error('MICR routing must be 9 digits.')
  if (!account || account.length > MICR_POS.onUsMax - MICR_POS.onUsSymbol) throw new Error('MICR account does not fit the On-Us field.')
  if (!num || MICR_POS.auxOnUsRight + num.length + 1 > MICR_POS.max) throw new Error('MICR check number does not fit the Auxiliary On-Us field.')
  const cells: MicrCell[] = []
  const rightToLeft = (s: string, firstPos: number) => { for (let i = 0; i < s.length; i++) cells.push({ pos: firstPos + i, ch: s[s.length - 1 - i] }) }
  cells.push({ pos: MICR_POS.onUsSymbol, ch: E13B.onUs.glyph })
  rightToLeft(account, MICR_POS.onUsSymbol + 1)
  cells.push({ pos: MICR_POS.transitRight, ch: E13B.transit.glyph })
  rightToLeft(routing, MICR_POS.transitRight + 1)
  cells.push({ pos: MICR_POS.transitLeft, ch: E13B.transit.glyph })
  cells.push({ pos: MICR_POS.auxOnUsRight, ch: E13B.onUs.glyph })
  rightToLeft(num, MICR_POS.auxOnUsRight + 1)
  cells.push({ pos: MICR_POS.auxOnUsRight + num.length + 1, ch: E13B.onUs.glyph })
  return cells
}

/**
 * Build the REAL MICR line for a check number from the server-only secrets. THROWS unless they are present
 * + valid (fail closed) — callers invoke this only when micrReadiness().ready is true.
 */
export function buildMicrCells(checkNumber: number | string): MicrCell[] {
  const s = readSecrets()
  if (!s) throw new Error('MICR secrets not configured (MICR_ROUTING/MICR_ACCOUNT).')
  if (!isValidRouting(s.routing)) throw new Error('MICR_ROUTING is not a valid 9-digit ABA routing number.')
  if (!isValidAccount(s.account)) throw new Error('MICR_ACCOUNT is not a valid account number.')
  return layoutMicrCells({ routing: s.routing, account: s.account, checkNumber })
}

/**
 * NON-NEGOTIABLE test line for VOID/calibration pages: all-zero routing (not a real institution), a
 * 0-9 ramp as the "account" so every digit glyph is exercised, and check number 00000. Contains no bank
 * data, so it is safe to store in a print-job payload and in test artifacts.
 */
export function testMicrCells(): MicrCell[] {
  return layoutMicrCells({ routing: '000000000', account: '0123456789', checkNumber: '00000' })
}
