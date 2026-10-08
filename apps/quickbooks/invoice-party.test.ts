import { describe, it, expect } from 'vitest'
import { chooseInvoiceParty } from './invoice-party'

const resident = { name: 'Jordan Reyes', email: 'jordan@home.com', phone: '5125551000' }

describe('chooseInvoiceParty — ordinary retail job (no override)', () => {
  it('bills the service customer and leaves BillEmail to the caller (unchanged behaviour)', () => {
    const p = chooseInvoiceParty({ serviceContact: resident, billingCustomer: null, recipientEmailOverride: null })
    expect(p.thirdParty).toBe(false)
    expect(p.contact).toEqual(resident)
    expect(p.recipientEmail).toBeNull() // null → caller keeps customer.billEmail
  })
})

describe('chooseInvoiceParty — overspray third-party (company pays for a resident)', () => {
  it('bills the company by ITS identity, sends to the rep, and never touches vehicle-owner contact', () => {
    const p = chooseInvoiceParty({
      serviceContact: resident,
      billingCustomer: { displayName: 'Acme Construction', email: 'ap@acme.com', phone: '5125559000' },
      recipientEmailOverride: 'rep@acme.com',
    })
    expect(p.thirdParty).toBe(true)
    expect(p.contact.name).toBe('Acme Construction')
    expect(p.contact.email).toBe('ap@acme.com')      // payer identity = company's own email
    expect(p.contact.phone).toBe('5125559000')
    expect(p.recipientEmail).toBe('rep@acme.com')     // BillEmail = the designated recipient
    // The resident's contact is NOT the billing identity (ownership/history stay with them elsewhere).
    expect(p.contact.email).not.toBe(resident.email)
  })
})

describe('chooseInvoiceParty — Caliber Collision (business account, per-advisor recipient)', () => {
  const caliber = { displayName: 'Caliber Collision', email: 'office@calibercollision.com', phone: '9797751500' }
  it('advisor A bills the company, invoice goes to advisor A', () => {
    const p = chooseInvoiceParty({ serviceContact: resident, billingCustomer: caliber, recipientEmailOverride: 'alicia.balanga@calibercollision.com' })
    expect(p.contact.name).toBe('Caliber Collision')
    expect(p.contact.email).toBe('office@calibercollision.com') // company email NOT overwritten by advisor
    expect(p.recipientEmail).toBe('alicia.balanga@calibercollision.com')
  })
  it('advisor B on another Caliber job gets a different recipient — same company identity', () => {
    const p = chooseInvoiceParty({ serviceContact: resident, billingCustomer: caliber, recipientEmailOverride: 'marcus.lee@calibercollision.com' })
    expect(p.contact.email).toBe('office@calibercollision.com')
    expect(p.recipientEmail).toBe('marcus.lee@calibercollision.com')
  })
  it('no advisor recipient → falls back to the company email for BillEmail', () => {
    const p = chooseInvoiceParty({ serviceContact: resident, billingCustomer: caliber, recipientEmailOverride: null })
    expect(p.recipientEmail).toBe('office@calibercollision.com')
  })
  it('company with no email on file → BillEmail from the recipient only; identity email stays null', () => {
    const p = chooseInvoiceParty({ serviceContact: resident, billingCustomer: { displayName: 'Caliber Collision', email: null, phone: '9797751500' }, recipientEmailOverride: 'alicia.balanga@calibercollision.com' })
    expect(p.contact.email).toBeNull()
    expect(p.recipientEmail).toBe('alicia.balanga@calibercollision.com')
  })
})

describe('chooseInvoiceParty — recipient override with no separate billing customer', () => {
  it('still bills the service customer but steers BillEmail to the override', () => {
    const p = chooseInvoiceParty({ serviceContact: resident, billingCustomer: null, recipientEmailOverride: 'someone-else@x.com' })
    expect(p.thirdParty).toBe(false)
    expect(p.contact).toEqual(resident)
    expect(p.recipientEmail).toBe('someone-else@x.com')
  })
  it('blank override strings are treated as null', () => {
    const p = chooseInvoiceParty({ serviceContact: resident, billingCustomer: null, recipientEmailOverride: '   ' })
    expect(p.recipientEmail).toBeNull()
  })
})
