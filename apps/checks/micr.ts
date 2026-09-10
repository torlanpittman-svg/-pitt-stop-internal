/**
 * MICR line generation for NEGOTIABLE checks — the magnetic E-13B line along the bottom of the check.
 *
 * SECURITY MODEL (critical):
 *   - The routing + account numbers are SECRETS. They live ONLY in server-only env vars
 *     MICR_ROUTING / MICR_ACCOUNT (set in Vercel; never in the settings table, never in git, never in
 *     client JS, never logged). This module is the ONLY reader. It exposes just masked previews.
 *   - A real MICR line prints ONLY when ALL are true: micr_enabled=true, MICR_ROUTING+MICR_ACCOUNT set
 *     and valid, and a licensed E-13B font is installed (MICR_FONT_PATH). Otherwise a check is NOT
 *     negotiable and the pipeline refuses to render a real MICR line.
 *   - TEST PRINT / VOID never call this — they draw a clearly-marked non-magnetic placeholder instead.
 *
 * MICR FORMAT: standard US business check, left→right as printed:
 *     ⑈ <check#> ⑈    ⑆ <routing(9)> ⑆    <account> ⑈
 *   (auxiliary On-Us = the SAME physical check number; transit = 9-digit routing incl. check digit;
 *    On-Us = account. The amount field on the far right is printed by the BANK at payment, not by us.)
 *   The EXACT account/check-number placement + spacing must match the American Momentum Bank MICR spec
 *   (or an existing pre-printed AMB check) — hence `fieldOrder` is confirmable, not assumed blindly.
 *
 * E-13B ENCODING: the four control symbols map to glyphs in the installed MICR font. The near-universal
 * convention (GnuMICR / IDAutomation / "MICR Encoding") is Transit=A, Amount=B, On-Us=C, Dash=D. We emit
 * BOTH the human unicode line (for review) and the font-encoded line (for the PDF), so switching fonts is
 * a one-line map change.
 */

// E-13B control symbols (Unicode) and their conventional font-glyph letters.
export const E13B = {
  transit: { unicode: '⑆', glyph: 'A' }, // ⑆
  amount:  { unicode: '⑇', glyph: 'B' }, // ⑇  (bank-only; we never print it)
  onUs:    { unicode: '⑈', glyph: 'C' }, // ⑈
  dash:    { unicode: '⑉', glyph: 'D' }, // ⑉
} as const

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
  fontInstalled: boolean       // MICR_FONT_PATH points at a readable E-13B font
  ready: boolean               // ALL of the above ⇒ a negotiable MICR line may be printed
  routingMask: string
  accountMask: string
}

export function micrFontPath(): string | null {
  const p = process.env.MICR_FONT_PATH
  return p && p.trim() ? p.trim() : null
}

/** Full readiness report (no secrets leaked — masks only). `enabled` is the micr_enabled setting. */
export function micrReadiness(enabled: boolean): MicrReadiness {
  const s = readSecrets()
  const routingValid = !!s && isValidRouting(s.routing)
  const accountValid = !!s && isValidAccount(s.account)
  const fontInstalled = !!micrFontPath()
  return {
    enabledFlagOn: enabled,
    secretsPresent: !!s,
    routingValid, accountValid, fontInstalled,
    ready: enabled && !!s && routingValid && accountValid && fontInstalled,
    routingMask: s ? maskTail(s.routing) : '',
    accountMask: s ? maskTail(s.account) : '',
  }
}

export interface MicrLine { unicode: string; encoded: string }

/**
 * Build the MICR line for a check number. THROWS unless secrets are present + valid (fail closed) — the
 * caller must only invoke this when micrReadiness().ready is true. `encoded` uses the font glyph letters
 * for the installed E-13B font; `unicode` is the human-readable equivalent.
 */
export function buildMicrLine(checkNumber: number | string): MicrLine {
  const s = readSecrets()
  if (!s) throw new Error('MICR secrets not configured (MICR_ROUTING/MICR_ACCOUNT).')
  if (!isValidRouting(s.routing)) throw new Error('MICR_ROUTING is not a valid 9-digit ABA routing number.')
  if (!isValidAccount(s.account)) throw new Error('MICR_ACCOUNT is not a valid account number.')
  const num = digits(String(checkNumber))
  const T = E13B.transit, O = E13B.onUs
  // ⑈ check# ⑈   ⑆ routing ⑆   account ⑈
  const unicode = `${O.unicode}${num}${O.unicode}  ${T.unicode}${s.routing}${T.unicode}  ${s.account}${O.unicode}`
  const encoded = `${O.glyph}${num}${O.glyph}  ${T.glyph}${s.routing}${T.glyph}  ${s.account}${O.glyph}`
  return { unicode, encoded }
}
