/**
 * Stock-number normalization rules.
 *
 * Applied between raw OCR output and the "AI prediction" shown to the employee.
 * The raw OCR text is preserved as stockRawOcr; the normalized result is stored
 * in stockNumberAiPrediction. Both flow into the learning system so we can
 * measure "did the AI misread it" vs "did a business rule fix it."
 *
 * Rules (in priority order):
 *   1.  $ → S        (dollar sign looks like S; applies anywhere)
 *   2.  5 → S        (in prefix position: first run of alpha-like characters)
 *   3.  0 → O        (digit zero in prefix, where letters are expected)
 *   4.  O → 0        (letter O in suffix, where digits are expected)
 *   5.  I → 1        (letter I in suffix)
 *   6.  B → 8        (letter B in suffix)
 */

export type NormalizationChange = {
  position: number  // 0-based index in the raw string
  from:     string
  to:       string
  rule:     string  // human-readable rule name
}

export type NormalizationResult = {
  raw:        string                // original, unmodified
  normalized: string                // after all rules applied
  changes:    NormalizationChange[]
}

// Returns the index where the alpha prefix ends (i.e., where the numeric suffix begins).
// Prefix = leading characters that should be letters (A-Z).
// Characters that "look like letters" ($ 5 at position 0) count as prefix.
function prefixEnd(s: string): number {
  let i = 0
  while (i < s.length) {
    const c = s[i].toUpperCase()
    // Clearly letter
    if (/[A-Z]/.test(c)) { i++; continue }
    // Visually letter-like — only in prefix
    if (c === '$' || c === '5' || c === '0') { i++; continue }
    break
  }
  return i
}

export function applyStockNormalizations(raw: string): NormalizationResult {
  const upper   = raw.toUpperCase()
  const chars   = upper.split('')
  const changes: NormalizationChange[] = []
  const pEnd    = prefixEnd(upper)

  for (let i = 0; i < chars.length; i++) {
    const c        = chars[i]
    const inPrefix = i < pEnd

    // Rule 1: $ → S (anywhere)
    if (c === '$') {
      changes.push({ position: i, from: c, to: 'S', rule: 'dollar-to-s' })
      chars[i] = 'S'
    }
    // Rule 2: 5 → S in prefix
    else if (inPrefix && c === '5') {
      changes.push({ position: i, from: c, to: 'S', rule: 'prefix-five-to-s' })
      chars[i] = 'S'
    }
    // Rule 3: 0 → O in prefix (digit where a letter is expected)
    else if (inPrefix && c === '0') {
      changes.push({ position: i, from: c, to: 'O', rule: 'prefix-zero-to-o' })
      chars[i] = 'O'
    }
    // Rule 4: O → 0 in suffix
    else if (!inPrefix && c === 'O') {
      changes.push({ position: i, from: c, to: '0', rule: 'suffix-o-to-zero' })
      chars[i] = '0'
    }
    // Rule 5: I → 1 in suffix
    else if (!inPrefix && c === 'I') {
      changes.push({ position: i, from: c, to: '1', rule: 'suffix-i-to-one' })
      chars[i] = '1'
    }
    // Rule 6: B → 8 in suffix
    else if (!inPrefix && c === 'B') {
      changes.push({ position: i, from: c, to: '8', rule: 'suffix-b-to-eight' })
      chars[i] = '8'
    }
  }

  return { raw: upper, normalized: chars.join(''), changes }
}

// Returns only the first character — the dealer prefix.
// "SP100744" → "S", "KLO6824" → "K", "TJ285137" → "T"
export function detectStockPrefix(stockNumber: string): string {
  const match = stockNumber.toUpperCase().match(/^[A-Z]/)
  return match ? match[0] : ''
}

export const RULE_LABELS: Record<string, string> = {
  'dollar-to-s':       '$ → S',
  'prefix-five-to-s':  '5 → S (prefix)',
  'prefix-zero-to-o':  '0 → O (prefix)',
  'suffix-o-to-zero':  'O → 0 (suffix)',
  'suffix-i-to-one':   'I → 1 (suffix)',
  'suffix-b-to-eight': 'B → 8 (suffix)',
}
