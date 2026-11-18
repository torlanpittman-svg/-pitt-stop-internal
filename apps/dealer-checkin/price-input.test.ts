import { describe, it, expect } from 'vitest'
import { sanitizePriceText, priceFieldValue, resolvePrice, type PriceText } from './price-input'

/** Simulates the controlled input: each change event is sanitized into state, as the screen does. */
function edit(steps: string[], suggested = 200) {
  let text: PriceText = null
  const shown: string[] = [priceFieldValue(text, suggested)]
  for (const raw of steps) {
    text = sanitizePriceText(raw)
    shown.push(priceFieldValue(text, suggested))
  }
  return { text, shown, result: resolvePrice(text, suggested) }
}

describe('dealer price field — regression: backspacing the default restored it (200 → 200125)', () => {
  it('200 → 20 → 2 → empty → 125 stays what was typed and submits exactly 125', () => {
    const { shown, result } = edit(['20', '2', '', '1', '12', '125'])
    expect(shown).toEqual(['200', '20', '2', '', '1', '12', '125'])
    expect(result).toEqual({ ok: true, rate: 125 })
  })

  it('an emptied field shows empty, not the suggested rate', () => {
    expect(priceFieldValue('', 200)).toBe('')
  })

  it('an emptied field is an error — never the suggested rate', () => {
    const r = resolvePrice('', 200)
    expect(r.ok).toBe(false)
    expect(resolvePrice('   ', 200).ok).toBe(false)
  })

  it('select-all replacement submits the replacement', () => {
    expect(edit(['1', '12', '125']).result).toEqual({ ok: true, rate: 125 })
  })
})

describe('default price', () => {
  it('applies while untouched and follows a changed suggestion', () => {
    expect(priceFieldValue(null, 200)).toBe('200')
    expect(resolvePrice(null, 200)).toEqual({ ok: true, rate: 200 })
    expect(resolvePrice(null, 125)).toEqual({ ok: true, rate: 125 })
  })

  it('does not overwrite an edited price when the suggestion changes', () => {
    expect(priceFieldValue('150', 125)).toBe('150')
    expect(resolvePrice('150', 125)).toEqual({ ok: true, rate: 150 })
  })

  it('a typed price equal to the suggestion is still accepted', () => {
    expect(resolvePrice('200', 200)).toEqual({ ok: true, rate: 200 })
  })
})

describe('decimals', () => {
  it('accepts decimal prices, including mid-typing states', () => {
    const { shown, result } = edit(['1', '12', '125', '125.', '125.5', '125.50'])
    expect(shown.at(-1)).toBe('125.50')
    expect(result).toEqual({ ok: true, rate: 125.5 })
    expect(resolvePrice('125.', 200)).toEqual({ ok: true, rate: 125 })
    expect(resolvePrice('.5', 200)).toEqual({ ok: true, rate: 0.5 })
    expect(resolvePrice('99.99', 200)).toEqual({ ok: true, rate: 99.99 })
  })

  it('rejects more than two decimal places instead of rounding silently', () => {
    expect(resolvePrice('125.555', 200).ok).toBe(false)
  })
})

describe('paste / sanitizing', () => {
  it.each([
    ['$125', '125'],
    [' 125 ', '125'],
    ['$1,250.50', '1250.50'],
    ['1,250', '1250'],
    ['125,50', '125.50'], // comma-locale decimal mark
    ['125,', '125.'],
    ['1.2.3', '1.23'],
    ['abc', ''],
    ['-125', '125'],
  ])('%s → %s', (raw, out) => {
    expect(sanitizePriceText(raw)).toBe(out)
  })

  it('pasted junk resolves to an error, not the suggested rate', () => {
    expect(resolvePrice(sanitizePriceText('abc'), 200).ok).toBe(false)
  })
})

describe('invalid prices', () => {
  it.each(['0', '0.00', '.', '.'])('%s is rejected', (t) => {
    expect(resolvePrice(t, 200).ok).toBe(false)
  })
})
