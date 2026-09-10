import { describe, it, expect } from 'vitest'
import { renderCheckPdf } from './pdf'
import type { CheckPrintPayload } from './render'

const payload: CheckPrintPayload = {
  pageWidthIn: 8.5, pageHeightIn: 11,
  fields: [
    { key: 'payee', value: 'Thompson Derrig', xIn: 1.05, yIn: 1.02, widthIn: 4.9, align: 'left', sizePt: 11 },
    { key: 'amountBox', value: '$1,234.56', xIn: 6.75, yIn: 0.98, widthIn: 1.4, align: 'right', sizePt: 11 },
  ],
}

describe('renderCheckPdf — dependency-free PDF', () => {
  it('emits a valid single-page PDF', () => {
    const pdf = renderCheckPdf(payload)
    const s = pdf.toString('latin1')
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s).toContain('/Type /Page')
    expect(s).toContain('%%EOF')
    expect(s).toContain('(Thompson Derrig)')
    expect(pdf.length).toBeGreaterThan(300)
  })

  it('adds a watermark only when asked (test prints)', () => {
    expect(renderCheckPdf(payload, { watermark: 'VOID' }).toString('latin1')).toContain('(VOID)')
    expect(renderCheckPdf(payload).toString('latin1')).not.toContain('(VOID)')
  })

  it('transliterates non-latin1 punctuation instead of dropping/corrupting it', () => {
    const p: CheckPrintPayload = { ...payload, fields: [{ key: 'memo', value: 'Deposit — “final” job', xIn: 0.6, yIn: 2.6, widthIn: 3, align: 'left', sizePt: 9 }] }
    const s = renderCheckPdf(p).toString('latin1')
    expect(s).toContain('(Deposit - "final" job)')
  })

  it('escapes PDF-special characters in values', () => {
    const p: CheckPrintPayload = { ...payload, fields: [{ key: 'payee', value: 'A (B) \\ C', xIn: 1, yIn: 1, widthIn: 3, align: 'left', sizePt: 10 }] }
    const s = renderCheckPdf(p).toString('latin1')
    expect(s).toContain('(A \\(B\\) \\\\ C)')
  })
})
