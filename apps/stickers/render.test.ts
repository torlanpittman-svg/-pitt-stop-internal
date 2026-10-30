import { describe, it, expect } from 'vitest'
import {
  buildStickerPayload, isStickerPayload, textWidthMm,
  STICKER_PAGE_WIDTH_MM, STICKER_PRINTABLE_WIDTH_MM, STICKER_CONTENT_WIDTH_MM,
} from './render'

const build = (date = 'Feb 25, 2027', miles = '192,781 mi') =>
  buildStickerPayload({ stickerId: 'S1', orderId: 'O1', values: { nextDateText: date, nextMileageText: miles } })

describe('buildStickerPayload', () => {
  it('is a 62 mm page with a sane computed cut length (QL-800 continuous roll limits)', () => {
    const p = build()
    expect(p.pageWidthMm).toBe(62)
    expect(p.pageHeightMm).toBeGreaterThanOrEqual(13) // printer minimum 12.7 mm
    expect(p.pageHeightMm).toBeLessThanOrEqual(80)
    expect(Number.isInteger(p.pageHeightMm)).toBe(true)
  })

  it('keeps every element inside the printable width, with clearance', () => {
    const margin = (STICKER_PAGE_WIDTH_MM - STICKER_PRINTABLE_WIDTH_MM) / 2
    // worst realistic case: widest month + 7-digit mileage
    const p = build('May 28, 2027', '1,992,781 mi')
    expect(p.logo.xMm).toBeGreaterThanOrEqual(margin)
    expect(p.logo.xMm + p.logo.wMm).toBeLessThanOrEqual(STICKER_PAGE_WIDTH_MM - margin)
    for (const t of p.texts) {
      expect(t.xMm).toBeGreaterThanOrEqual(margin)
      expect(t.xMm + textWidthMm(t.value, t.sizePt, t.bold)).toBeLessThanOrEqual(STICKER_PAGE_WIDTH_MM - margin + 0.01)
    }
    for (const ic of p.icons) {
      expect(ic.xMm).toBeGreaterThanOrEqual(margin)
      expect(ic.xMm + ic.sizeMm).toBeLessThanOrEqual(STICKER_PAGE_WIDTH_MM - margin)
    }
  })

  it('keeps every element inside the page vertically', () => {
    const p = build()
    expect(p.logo.yMm).toBeGreaterThan(0)
    for (const t of p.texts) {
      expect(t.yMm).toBeGreaterThan(0)
      expect(t.yMm).toBeLessThan(p.pageHeightMm)
    }
    for (const ic of p.icons) expect(ic.yMm + ic.sizeMm).toBeLessThan(p.pageHeightMm)
  })

  it('centers the logo and the title', () => {
    const p = build()
    expect(p.logo.xMm + p.logo.wMm / 2).toBeCloseTo(STICKER_PAGE_WIDTH_MM / 2, 5)
    const title = p.texts.find((t) => t.value === 'Next service due')!
    const mid = title.xMm + textWidthMm(title.value, title.sizePt, title.bold) / 2
    expect(mid).toBeCloseTo(STICKER_PAGE_WIDTH_MM / 2, 5)
  })

  it('carries the dynamic values and both icons', () => {
    const p = build('Mar 3, 2027', '45,500 mi')
    expect(p.texts.map((t) => t.value)).toContain('Mar 3, 2027')
    expect(p.texts.map((t) => t.value)).toContain('45,500 mi')
    expect(p.icons.map((i) => i.kind).sort()).toEqual(['calendar', 'gauge'])
    expect(p.kind).toBe('oil_sticker')
    expect(p.stickerId).toBe('S1')
    expect(p.orderId).toBe('O1')
  })

  it('page height is identical for different values (stable cut length)', () => {
    expect(build('May 1, 2027', '900 mi').pageHeightMm).toBe(build('Dec 31, 2031', '1,999,999 mi').pageHeightMm)
  })

  it('content width constant stays inside the printable area', () => {
    expect(STICKER_CONTENT_WIDTH_MM).toBeLessThanOrEqual(STICKER_PRINTABLE_WIDTH_MM)
  })
})

describe('quick-print provenance', () => {
  const quick = {
    source: 'quick' as const, requestId: 'r1', actorKey: 'tony', actorName: 'Tony',
    mileage: 187781, intervalMiles: 5000, intervalMonths: 6,
    nextMileage: 192781, nextDate: '2027-04-30', nextDateText: 'Apr 30, 2027', nextMileageText: '192,781 mi',
  }

  it('a job sticker carries NO quick block (the two entry points stay distinguishable)', () => {
    expect(build()).not.toHaveProperty('quick')
  })

  it('a quick sticker carries its request, actor, and values — and prints identically', () => {
    const p = buildStickerPayload({ stickerId: 'quick:r1', orderId: 'quick:r1', values: { nextDateText: 'Feb 25, 2027', nextMileageText: '192,781 mi' }, quick })
    expect(p.quick).toEqual(quick)
    expect(isStickerPayload(p)).toBe(true)
    // Same layout as the job sticker: provenance never changes a single printed position.
    const job = build()
    expect(p.pageWidthMm).toBe(job.pageWidthMm)
    expect(p.pageHeightMm).toBe(job.pageHeightMm)
    expect(p.logo).toEqual(job.logo)
    expect(p.texts).toEqual(job.texts)
    expect(p.icons).toEqual(job.icons)
  })
})

describe('isStickerPayload', () => {
  it('accepts a built payload and rejects a check-shaped one', () => {
    expect(isStickerPayload(build())).toBe(true)
    expect(isStickerPayload({ pageWidthIn: 8.5, pageHeightIn: 11, fields: [] })).toBe(false)
    expect(isStickerPayload(null)).toBe(false)
  })
})
