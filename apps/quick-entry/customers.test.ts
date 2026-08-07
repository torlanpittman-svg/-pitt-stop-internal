import { describe, it, expect } from 'vitest'
import { normalizePhone, splitName, customerKey, vehicleLabel, aggregateCustomers, type JobRow } from './customers'

describe('customer helpers', () => {
  it('normalizePhone strips non-digits', () => {
    expect(normalizePhone('(512) 555-1234')).toBe('5125551234')
    expect(normalizePhone(null)).toBe('')
  })
  it('splitName splits first/last', () => {
    expect(splitName('John Smith')).toEqual({ first: 'John', last: 'Smith' })
    expect(splitName('Mary Jane Watson')).toEqual({ first: 'Mary', last: 'Jane Watson' })
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: '' })
  })
  it('customerKey prefers phone, then email, then name', () => {
    expect(customerKey({ phone: '(512) 555-1234', email: 'a@b.com', name: 'John' })).toBe('p:5125551234')
    expect(customerKey({ phone: null, email: 'A@B.com', name: 'John' })).toBe('e:a@b.com')
    expect(customerKey({ phone: null, email: null, name: '  John  Smith ' })).toBe('n:john smith')
  })
  it('vehicleLabel joins year/make/model', () => {
    expect(vehicleLabel({ year: '2020', make: 'Ford', model: 'F-150' })).toBe('2020 Ford F-150')
  })
})

const row = (o: Partial<JobRow>): JobRow => ({ customerName: null, customerPhone: null, customerEmail: null, vehicleId: null, year: null, make: null, model: null, vin: null, ...o })

describe('aggregateCustomers', () => {
  it('groups by person (phone) and collects distinct vehicles', () => {
    const rows = [
      row({ customerName: 'John Smith', customerPhone: '512-555-1234', vehicleId: 'v1', year: '2020', make: 'Ford', model: 'F-150' }),
      row({ customerName: 'John Smith', customerPhone: '(512) 5551234', vehicleId: 'v2', year: '2018', make: 'Chevrolet', model: 'Tahoe' }),
      row({ customerName: 'John Smith', customerPhone: '5125551234', vehicleId: 'v1', year: '2020', make: 'Ford', model: 'F-150' }), // dup vehicle
    ]
    const out = aggregateCustomers(rows)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ first: 'John', last: 'Smith', phone: '512-555-1234' })
    expect(out[0].vehicles.map((v) => v.label)).toEqual(['2020 Ford F-150', '2018 Chevrolet Tahoe'])
  })
  it('keeps same-name people separate by phone', () => {
    const out = aggregateCustomers([
      row({ customerName: 'John Smith', customerPhone: '1111111111', vehicleId: 'v1', make: 'Ford' }),
      row({ customerName: 'John Smith', customerPhone: '2222222222', vehicleId: 'v2', make: 'Honda' }),
    ])
    expect(out).toHaveLength(2)
  })
  it('drops vehicles with no label and no VIN; latest contact wins', () => {
    const out = aggregateCustomers([
      row({ customerName: 'Ann Lee', customerEmail: 'ann@x.com', vehicleId: 'v9' }), // empty vehicle → dropped
    ])
    expect(out[0].vehicles).toHaveLength(0)
    expect(out[0].email).toBe('ann@x.com')
  })
})
