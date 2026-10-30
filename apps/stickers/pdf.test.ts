import { describe, it, expect } from 'vitest'
import { renderStickerPdf } from './pdf'
import { buildStickerPayload, LOGO_ASPECT_W, LOGO_ASPECT_H } from './render'
import { LOGO_WIDTH_PX, LOGO_HEIGHT_PX, LOGO_GRAY_DEFLATED_BASE64 } from './logo-data'
import { inflateSync } from 'node:zlib'

const payload = buildStickerPayload({ stickerId: 'S1', orderId: 'O1', values: { nextDateText: 'Feb 25, 2027', nextMileageText: '192,781 mi' } })

describe('renderStickerPdf', () => {
  const pdf = renderStickerPdf(payload)
  const text = pdf.toString('latin1')

  it('is a complete single-page PDF', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text).toContain('%%EOF')
    expect(text).toContain('/Count 1')
  })

  it('has a MediaBox that is exactly the label size in points', () => {
    const w = (payload.pageWidthMm / 25.4) * 72
    const h = (payload.pageHeightMm / 25.4) * 72
    expect(text).toContain(`/MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}]`)
  })

  it('draws the dynamic date and mileage in Helvetica-Bold', () => {
    expect(text).toContain('(Feb 25, 2027) Tj')
    expect(text).toContain('(192,781 mi) Tj')
    expect(text).toContain('(Next service due) Tj')
    expect(text).toContain('/Helvetica-Bold')
  })

  it('embeds the logo as a lossless grayscale image of the master dimensions', () => {
    expect(text).toContain(`/Width ${LOGO_WIDTH_PX}`)
    expect(text).toContain(`/Height ${LOGO_HEIGHT_PX}`)
    expect(text).toContain('/ColorSpace /DeviceGray')
    expect(text).toContain('/Filter /FlateDecode')
    expect(text).toContain('/Im1 Do')
  })

  it('xref offsets point at their objects', () => {
    const xref = /xref\n0 (\d+)\n0000000000 65535 f \n([\s\S]*?)trailer/.exec(text)!
    const lines = xref[2].trim().split('\n')
    lines.forEach((line, i) => {
      const off = parseInt(line.slice(0, 10), 10)
      expect(text.slice(off, off + 20)).toMatch(new RegExp(`^${i + 1} 0 obj`))
    })
  })
})

describe('logo master consistency', () => {
  it('render.ts aspect constants match the embedded image data', () => {
    expect(LOGO_ASPECT_W).toBe(LOGO_WIDTH_PX)
    expect(LOGO_ASPECT_H).toBe(LOGO_HEIGHT_PX)
  })
  it('the deflated data inflates to exactly width×height gray bytes', () => {
    const raw = inflateSync(Buffer.from(LOGO_GRAY_DEFLATED_BASE64, 'base64'))
    expect(raw.length).toBe(LOGO_WIDTH_PX * LOGO_HEIGHT_PX)
  })
})
