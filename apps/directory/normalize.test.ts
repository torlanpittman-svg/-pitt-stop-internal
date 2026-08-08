import { describe, it, expect } from 'vitest'
import {
  normalizePhone, normalizeEmail, normalizeName, splitName, parseMoney,
  parseCsv, mapHeaders, parseAutoLeapRow, customerTypeFor, sourceKeyFor,
  buildIndex, classify,
} from './normalize.mjs'

describe('normalization', () => {
  it('normalizePhone strips non-digits and US country code', () => {
    expect(normalizePhone('(979) 224-0489')).toBe('9792240489')
    expect(normalizePhone('1-615-594-3277')).toBe('6155943277')
    expect(normalizePhone(null)).toBe('')
  })
  it('normalizeEmail/Name lowercase + trim + collapse', () => {
    expect(normalizeEmail('  John@Example.COM ')).toBe('john@example.com')
    expect(normalizeName('  Mary   Jane  Watson ')).toBe('mary jane watson')
  })
  it('splitName handles "First Last" and "Last, First"', () => {
    expect(splitName('Trudy Bennett')).toEqual({ first: 'Trudy', last: 'Bennett' })
    expect(splitName('Bennett, Trudy')).toEqual({ first: 'Trudy', last: 'Bennett' })
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: '' })
  })
  it('parseMoney handles $ and commas', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56)
    expect(parseMoney('')).toBe(0)
  })
})

describe('parseCsv', () => {
  it('handles quotes, embedded commas, and CRLF', () => {
    const rows = parseCsv('a,b,c\r\n"x,y",z,"line\nbreak"\n')
    expect(rows).toEqual([['a', 'b', 'c'], ['x,y', 'z', 'line\nbreak']])
  })
  it('strips a UTF-8 BOM and drops empty rows', () => {
    const rows = parseCsv('﻿name,phone\n\nA,1\n')
    expect(rows[0]).toEqual(['name', 'phone'])
    expect(rows).toHaveLength(2)
  })
})

describe('mapHeaders', () => {
  it('maps AutoLeap Customer-report headers and reports extras', () => {
    const { map, unmapped } = mapHeaders(['Type', 'Customer', 'Company', 'Email', 'Phone', 'Created date', '# Vehicles', 'Invoiced amount', 'Weird Extra'])
    expect(map.name).toBe(1)
    expect(map.email).toBe(3)
    expect(map.phone).toBe(4)
    expect(map.vehicleCount).toBe(6)
    expect(map.invoiced).toBe(7)
    expect(unmapped).toContain('Weird Extra')
  })
})

describe('parseAutoLeapRow + type', () => {
  const { map } = mapHeaders(['Type', 'Customer', 'Company', 'Email', 'Phone', 'Created date', '# Vehicles', 'Invoiced amount'])
  it('parses a normal invoiced customer', () => {
    const r = parseAutoLeapRow(['Regular', 'Trudy Bennett', '', 'tbennett@tamu.edu', '(979) 224-0489', 'Jul 18, 2026', '1', '$450.00'], map)
    expect(r.firstName).toBe('Trudy')
    expect(r.normalizedPhone).toBe('9792240489')
    expect(r.normalizedEmail).toBe('tbennett@tamu.edu')
    expect(r.autoleapVehicleCount).toBe(1)
    expect(r.customerType).toBe('retail')
  })
  it('classifies a never-invoiced person as prospect', () => {
    expect(customerTypeFor('Regular', 0)).toBe('prospect')
    expect(customerTypeFor('Dealer', 500)).toBe('dealer')
    expect(customerTypeFor('Fleet', 500)).toBe('business')
  })
})

describe('classify (match decisions)', () => {
  const existing = [
    { id: 'c1', source: 'autoleap', sourceKey: 'p:9792240489', normalizedPhone: '9792240489', normalizedEmail: 'trudy@x.com', normalizedName: 'trudy bennett' },
    { id: 'c2', source: 'autoleap', sourceKey: 'e:mary@x.com', normalizedPhone: '', normalizedEmail: 'mary@x.com', normalizedName: 'mary nettum' },
    { id: 'c3', source: 'autoleap', sourceKey: 'n:john jordan|', normalizedPhone: '', normalizedEmail: '', normalizedName: 'john jordan' },
    // phone-keyed record that also has an email — used to test an email-only merge
    // that is NOT an idempotent source_key hit.
    { id: 'c4', source: 'autoleap', sourceKey: 'p:5551112222', normalizedPhone: '5551112222', normalizedEmail: 'kevin@x.com', normalizedName: 'kevin lee' },
  ]
  const index = buildIndex(existing)
  const rec = (o: any) => ({ normalizedName: '', normalizedPhone: '', normalizedEmail: '', createdDate: null, ...o })

  it('idempotent re-import → update via source_key', () => {
    const d = classify(rec({ normalizedName: 'trudy bennett', normalizedPhone: '9792240489' }), index)
    expect(d.action).toBe('update'); expect(d.targetId).toBe('c1')
  })
  it('new phone match on a different-keyed row → merge', () => {
    const d = classify(rec({ normalizedName: 'trudy b', normalizedPhone: '9792240489', createdDate: 'x' }), index)
    // different name+date but same phone → not a source_key hit, but strong phone merge
    expect(['merge', 'update']).toContain(d.action)
    expect(d.targetId).toBe('c1')
  })
  it('email-only incoming whose email is an existing source_key → update (idempotent)', () => {
    const d = classify(rec({ normalizedName: 'mary n', normalizedEmail: 'mary@x.com', createdDate: 'y' }), index)
    expect(d.action).toBe('update'); expect(d.targetId).toBe('c2')
  })
  it('email match on a differently-keyed record → merge', () => {
    const d = classify(rec({ normalizedName: 'kev', normalizedEmail: 'kevin@x.com', createdDate: 'z' }), index)
    expect(d.action).toBe('merge'); expect(d.targetId).toBe('c4'); expect(d.reason).toBe('email')
  })
  it('name-only match → review (never auto-merge)', () => {
    const d = classify(rec({ normalizedName: 'john jordan', createdDate: 'different' }), index)
    expect(d.action).toBe('review'); expect(d.reason).toBe('name_only')
    expect(d.candidateIds).toEqual(['c3'])
  })
  it('no signal → new', () => {
    const d = classify(rec({ normalizedName: 'brand new', normalizedPhone: '5550009999' }), index)
    expect(d.action).toBe('new')
  })
  it('empty row → skip', () => {
    expect(classify(rec({}), index).action).toBe('skip')
  })
})
