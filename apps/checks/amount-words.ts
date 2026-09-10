/**
 * Convert a cents amount to the legal "written amount" line on a check, e.g.
 *   150034  ->  "One Thousand Five Hundred and 34/100"
 *        0  ->  "Zero and 00/100"
 * Pure + unit-tested. US English, whole-dollar words + cents as NN/100. No currency symbol.
 * Caps at 999,999,999.99 (well beyond any real Pitt Stop check) and rejects negatives.
 */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const SCALES = ['', 'Thousand', 'Million']

function threeDigitWords(n: number): string {
  const parts: string[] = []
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  if (hundreds) parts.push(ONES[hundreds], 'Hundred')
  if (rest < 20) { if (rest) parts.push(ONES[rest]) }
  else {
    parts.push(TENS[Math.floor(rest / 10)])
    if (rest % 10) parts.push(ONES[rest % 10])
  }
  return parts.join(' ')
}

/** Whole-dollar amount → words (no cents). 0 → "Zero". */
export function dollarsToWords(dollars: number): string {
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error('dollarsToWords: invalid amount')
  const whole = Math.floor(dollars)
  if (whole === 0) return 'Zero'
  const groups: number[] = []
  let n = whole
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000) }
  if (groups.length > SCALES.length) throw new Error('dollarsToWords: amount too large')
  const out: string[] = []
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue
    out.push(threeDigitWords(groups[i]))
    if (SCALES[i]) out.push(SCALES[i])
  }
  return out.join(' ')
}

/** Full check "written amount" line from cents: "<words> and NN/100". */
export function amountToWords(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('amountToWords: cents must be a non-negative integer')
  const dollars = Math.floor(cents / 100)
  const rem = cents % 100
  return `${dollarsToWords(dollars)} and ${String(rem).padStart(2, '0')}/100`
}

/** "$1,500.34" numeric box format from cents. */
export function formatAmount(cents: number): string {
  const neg = cents < 0
  const v = Math.abs(cents)
  const s = (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${neg ? '-' : ''}$${s}`
}
