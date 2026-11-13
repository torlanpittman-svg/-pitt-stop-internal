import { describe, it, expect } from 'vitest'
import { validateReceiptUpload, extForMime, MAX_UPLOAD_BYTES } from './upload-validation'
import { detectImageMime } from '@/platform/image'

// Magic-byte prefixes for real formats.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
const HTML = new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>')
const PDF = new TextEncoder().encode('%PDF-1.7\n...')

describe('detectImageMime — signature sniffing', () => {
  it('detects supported raster formats', () => {
    expect(detectImageMime(JPEG)).toBe('image/jpeg')
    expect(detectImageMime(PNG)).toBe('image/png')
    expect(detectImageMime(WEBP)).toBe('image/webp')
  })
  it('returns null for SVG / HTML / PDF / empty', () => {
    expect(detectImageMime(SVG)).toBeNull()
    expect(detectImageMime(HTML)).toBeNull()
    expect(detectImageMime(PDF)).toBeNull()
    expect(detectImageMime(new Uint8Array([]))).toBeNull()
  })
})

describe('validateReceiptUpload', () => {
  it('accepts a real JPEG/PNG/WEBP and returns the authoritative mime', () => {
    expect(validateReceiptUpload('image/jpeg', 5000, JPEG)).toEqual({ ok: true, mime: 'image/jpeg' })
    expect(validateReceiptUpload('image/png', 5000, PNG)).toEqual({ ok: true, mime: 'image/png' })
    expect(validateReceiptUpload('image/webp', 5000, WEBP)).toEqual({ ok: true, mime: 'image/webp' })
  })
  it('treats image/jpg as image/jpeg (declared normalization)', () => {
    expect(validateReceiptUpload('image/jpg', 5000, JPEG)).toEqual({ ok: true, mime: 'image/jpeg' })
  })
  it('rejects SVG and HTML by signature even if a benign type is declared (415)', () => {
    expect(validateReceiptUpload('image/png', 5000, SVG)).toMatchObject({ ok: false, status: 415 })
    expect(validateReceiptUpload('image/jpeg', 5000, HTML)).toMatchObject({ ok: false, status: 415 })
  })
  it('rejects a PDF (extraction path is image-only) (415)', () => {
    expect(validateReceiptUpload('application/pdf', 5000, PDF)).toMatchObject({ ok: false, status: 415 })
  })
  it('rejects a declared/detected mismatch (spoofed content) (415)', () => {
    // real PNG bytes but declared as webp → mismatch
    expect(validateReceiptUpload('image/webp', 5000, PNG)).toMatchObject({ ok: false, status: 415 })
  })
  it('does not rely on the declared type — a blank declaration with real bytes is accepted', () => {
    expect(validateReceiptUpload('', 5000, JPEG)).toEqual({ ok: true, mime: 'image/jpeg' })
  })
  it('enforces the size cap (413) and rejects empty (400)', () => {
    expect(validateReceiptUpload('image/jpeg', MAX_UPLOAD_BYTES + 1, JPEG)).toMatchObject({ ok: false, status: 413 })
    expect(validateReceiptUpload('image/jpeg', 0, JPEG)).toMatchObject({ ok: false, status: 400 })
  })
  it('extForMime maps to a stable extension', () => {
    expect(extForMime('image/jpeg')).toBe('jpg')
    expect(extForMime('image/png')).toBe('png')
    expect(extForMime('image/webp')).toBe('webp')
  })
})

// ── Business receipts also accept a PDF invoice and pasted email text (migration 0078 release) ──
import { validateReceiptFile, validatePastedText, extForStoredType, isPdfHead, isImageType, MAX_PASTED_TEXT } from './upload-validation'

describe('validateReceiptFile — photos AND PDF invoices (business receipts only)', () => {
  it('accepts a real PDF by its %PDF- signature', () => {
    expect(isPdfHead(PDF)).toBe(true)
    expect(validateReceiptFile('application/pdf', 60_000, PDF)).toEqual({ ok: true, mime: 'application/pdf' })
    expect(validateReceiptFile('', 60_000, PDF)).toEqual({ ok: true, mime: 'application/pdf' }) // phones often send no type
  })
  it('still accepts photos exactly as before', () => {
    expect(validateReceiptFile('image/jpeg', 5000, JPEG)).toEqual({ ok: true, mime: 'image/jpeg' })
    expect(validateReceiptFile('image/jpg', 5000, JPEG)).toEqual({ ok: true, mime: 'image/jpeg' })
  })
  it('rejects a file that only CLAIMS to be a PDF, and a PDF declared as an image', () => {
    expect(validateReceiptFile('application/pdf', 5000, HTML)).toMatchObject({ ok: false, status: 415 })
    expect(validateReceiptFile('application/pdf', 5000, JPEG)).toMatchObject({ ok: false, status: 415 })
    expect(validateReceiptFile('image/jpeg', 5000, PDF)).toMatchObject({ ok: false, status: 415 })
  })
  it('rejects SVG / HTML and an oversized or empty PDF', () => {
    expect(validateReceiptFile('image/svg+xml', 5000, SVG)).toMatchObject({ ok: false, status: 415 })
    expect(validateReceiptFile('text/html', 5000, HTML)).toMatchObject({ ok: false, status: 415 })
    expect(validateReceiptFile('application/pdf', MAX_UPLOAD_BYTES + 1, PDF)).toMatchObject({ ok: false, status: 413 })
    expect(validateReceiptFile('application/pdf', 0, PDF)).toMatchObject({ ok: false, status: 400 })
  })
  it('the SHARED photo validator (parts screenshot import) still refuses PDFs', () => {
    expect(validateReceiptUpload('application/pdf', 5000, PDF)).toMatchObject({ ok: false, status: 415 })
  })
  it('storage extensions cover every stored type', () => {
    expect(extForStoredType('application/pdf')).toBe('pdf')
    expect(extForStoredType('text/plain')).toBe('txt')
    expect(extForStoredType('image/png')).toBe('png')
    expect(isImageType('application/pdf')).toBe(false)
    expect(isImageType('image/webp')).toBe(true)
  })
})

describe('validatePastedText — pasted email receipts', () => {
  it('accepts a real receipt email, normalizing line endings and stripping control characters', () => {
    const v = validatePastedText('  Tesla order GPO-3Y3WMP6N16\r\nTotal: $80.21\u0000\u0007  ')
    expect(v).toEqual({ ok: true, text: 'Tesla order GPO-3Y3WMP6N16\nTotal: $80.21' })
  })
  it('rejects too-short, too-long and non-string input', () => {
    expect(validatePastedText('hi')).toMatchObject({ ok: false, status: 400 })
    expect(validatePastedText('x'.repeat(MAX_PASTED_TEXT + 1))).toMatchObject({ ok: false, status: 413 })
    expect(validatePastedText(null)).toMatchObject({ ok: false, status: 400 })
  })
})
