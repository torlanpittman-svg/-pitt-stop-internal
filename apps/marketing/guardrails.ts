/**
 * Brand-safety guardrails for any outbound copy (AI-generated or human-written) BEFORE it can
 * reach a Ready campaign, an approved post, or a provider send. Deterministic + testable. The AI
 * layer runs this on its own output and surfaces warnings; the campaign layer refuses to mark a
 * campaign Ready while there are blocking errors. This is defense-in-depth, not a replacement for
 * manager approval.
 */
import { MARKETING_PROFILE } from './profile'

export type GuardrailSeverity = 'error' | 'warning'
export interface GuardrailFinding { severity: GuardrailSeverity; code: string; message: string }
export interface GuardrailResult { ok: boolean; findings: GuardrailFinding[] }

// Phrases that assert an outcome we cannot promise (condition-dependent work).
const PROHIBITED_PATTERNS: Array<{ code: string; re: RegExp; message: string }> = [
  { code: 'guarantee', re: /\b(guarantee[ds]?|100%\s*guaranteed?)\b/i, message: 'Avoid guarantees for condition-dependent work.' },
  { code: 'permanent', re: /\b(permanent(ly)?|forever|never\s+again)\b/i, message: 'Avoid "permanent/forever" claims.' },
  { code: 'brand_new', re: /\b(like\s+new|brand\s+new|showroom\s+new|good\s+as\s+new)\b/i, message: 'Avoid "like new" absolute claims.' },
  { code: 'remove_all', re: /\b(remove[s]?\s+all|eliminate[s]?\s+all|all\s+scratches)\b/i, message: 'Avoid "removes all" absolutes.' },
  { code: 'cheapest', re: /\b(cheapest|lowest\s+price|beat\s+any\s+price)\b/i, message: 'Do not compete on being the cheapest — Pitt Stop sells value, not price.' },
]

// Fake-urgency / spam markers.
const URGENCY_PATTERNS: Array<{ code: string; re: RegExp; message: string }> = [
  { code: 'act_now', re: /\b(act\s+now|hurry|don'?t\s+wait|last\s+chance|limited\s+time\s+only|while\s+supplies\s+last)\b/i, message: 'Reads as fake urgency.' },
  { code: 'spam_alert', re: /(🚨|🔥){1,}|\bmega\s+deal\b|\bblowout\b|\bflash\s+sale\b/i, message: 'Reads as spammy/hype.' },
]

function countEmojis(text: string): number {
  // Extended-pictographic range via surrogate scan (keeps the build off \p{} target quirks).
  const matches = text.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu)
  return matches ? matches.length : 0
}

function capsRatio(text: string): number {
  const letters = text.replace(/[^A-Za-z]/g, '')
  if (letters.length < 12) return 0
  const upper = text.replace(/[^A-Z]/g, '').length
  return upper / letters.length
}

export interface GuardrailOptions {
  /** Max emojis allowed before it counts as spammy (default 2). */
  maxEmojis?: number
  /** Whether an offer/discount is approved for this copy. If false, discount wording is an error. */
  offerApproved?: boolean
}

/** Validate a single piece of copy. */
export function validateCopy(text: string | null | undefined, opts: GuardrailOptions = {}): GuardrailResult {
  const findings: GuardrailFinding[] = []
  const body = (text ?? '').trim()
  const maxEmojis = opts.maxEmojis ?? 2

  if (!body) return { ok: true, findings }

  for (const p of PROHIBITED_PATTERNS) {
    if (p.re.test(body)) findings.push({ severity: 'error', code: p.code, message: p.message })
  }
  for (const p of URGENCY_PATTERNS) {
    if (p.re.test(body)) findings.push({ severity: 'warning', code: p.code, message: p.message })
  }

  const emojis = countEmojis(body)
  if (emojis > maxEmojis) {
    findings.push({ severity: 'warning', code: 'emoji_spam', message: `Too many emojis (${emojis}); keep it clean and professional.` })
  }

  const caps = capsRatio(body)
  if (caps > 0.5) {
    findings.push({ severity: 'warning', code: 'all_caps', message: 'Excessive capitalization reads as shouting/spam.' })
  }

  // Discount wording without an approved offer is a brand-safety error (no invented discounts).
  if (opts.offerApproved === false && /\b(\d{1,3}%\s*off|save\s+\$?\d+|discount|coupon|promo\s*code)\b/i.test(body)) {
    findings.push({ severity: 'error', code: 'unapproved_offer', message: 'Discount/offer wording without an approved offer — never invent a discount.' })
  }

  return { ok: !findings.some((f) => f.severity === 'error'), findings }
}

/** Validate a whole campaign's copy surfaces at once. */
export function validateCampaignCopy(
  parts: { smsCopy?: string | null; emailSubject?: string | null; emailBody?: string | null },
  opts: GuardrailOptions = {},
): GuardrailResult {
  const all: GuardrailFinding[] = []
  for (const [label, value] of Object.entries(parts)) {
    const res = validateCopy(value, opts)
    for (const f of res.findings) all.push({ ...f, code: `${label}:${f.code}` })
  }
  return { ok: !all.some((f) => f.severity === 'error'), findings: all }
}

/** The list of prohibited-claim phrases, exposed for prompt construction + UI hints. */
export function prohibitedClaims(): string[] {
  return MARKETING_PROFILE.prohibitedClaims
}
