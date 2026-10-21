import { describe, expect, it } from 'vitest'
import { formatUsPhone, isValidEmail, isValidUsPhone, validateContact } from './contact'

describe('booking contact rules', () => {
  it('requires first name, last name, phone and email', () => {
    expect(Object.keys(validateContact({ firstName: '', lastName: ' ', phone: '', email: '' })).sort()).toEqual(['email', 'firstName', 'lastName', 'phone'])
    expect(validateContact({ firstName: 'Ana', lastName: 'Diaz', phone: '(979) 555-0123', email: 'ana@example.com' })).toEqual({})
  })
  it('checks US phone format only', () => {
    expect(isValidUsPhone('979-555-0123')).toBe(true)
    expect(isValidUsPhone('+1 979 555 0123')).toBe(true)
    expect(isValidUsPhone('555-0123')).toBe(false)
    expect(isValidUsPhone('(079) 555-0123')).toBe(false)
    expect(isValidUsPhone('979 155 0123')).toBe(false)
    expect(formatUsPhone('19795550123')).toBe('(979) 555-0123')
  })
  it('checks email format only', () => {
    expect(isValidEmail('a.b@example.co')).toBe(true)
    expect(isValidEmail('a@b')).toBe(false)
    expect(isValidEmail('a @b.com')).toBe(false)
  })
})
