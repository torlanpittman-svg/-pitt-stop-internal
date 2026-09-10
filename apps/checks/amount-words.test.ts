import { describe, it, expect } from 'vitest'
import { amountToWords, dollarsToWords, formatAmount } from './amount-words'

describe('amountToWords — legal written amount line', () => {
  it('zero', () => expect(amountToWords(0)).toBe('Zero and 00/100'))
  it('cents only', () => expect(amountToWords(34)).toBe('Zero and 34/100'))
  it('whole dollar', () => expect(amountToWords(100)).toBe('One and 00/100'))
  it('common check', () => expect(amountToWords(150034)).toBe('One Thousand Five Hundred and 34/100'))
  it('exact thousand', () => expect(amountToWords(100000)).toBe('One Thousand and 00/100'))
  it('teens + tens', () => expect(dollarsToWords(19)).toBe('Nineteen'))
  it('twenty-one', () => expect(dollarsToWords(21)).toBe('Twenty One'))
  it('hundreds', () => expect(dollarsToWords(305)).toBe('Three Hundred Five'))
  it('million', () => expect(dollarsToWords(1_000_000)).toBe('One Million'))
  it('pads single cent digit', () => expect(amountToWords(105)).toBe('One and 05/100'))
})

describe('amountToWords — validation', () => {
  it('rejects negative', () => expect(() => amountToWords(-1)).toThrow())
  it('rejects non-integer cents', () => expect(() => amountToWords(10.5)).toThrow())
})

describe('formatAmount — numeric box', () => {
  it('thousands separator + two decimals', () => expect(formatAmount(150034)).toBe('$1,500.34'))
  it('zero', () => expect(formatAmount(0)).toBe('$0.00'))
})
