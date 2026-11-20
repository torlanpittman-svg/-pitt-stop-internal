/**
 * Job screen inline price box — what a typed amount means (pure), the save order, and where Tab goes.
 */
import { describe, it, expect } from 'vitest'
import { neighbourPriceBox, planInlinePrice, priceBoxText, rebasePriceText, serialQueue } from './inline-price'
import type { ServiceView } from './save-feedback'

const svc = (priceCents: number | null): ServiceView => ({ id: 's1', title: 'Interior Detail', priceCents, suggestedCents: null })

describe('planInlinePrice — the editor’s own price rules', () => {
  it('a blank box on an unpriced service sends nothing (it stays unpriced, never $0)', () => {
    expect(planInlinePrice(svc(null), '')).toEqual({ kind: 'none' })
    expect(planInlinePrice(svc(null), '   ')).toEqual({ kind: 'none' })
  })

  it('a typed amount becomes the editor’s set_service_price edit, in whole cents', () => {
    expect(planInlinePrice(svc(null), '125.50')).toEqual({ kind: 'save', cents: 12550, edit: { action: 'set_service_price', serviceId: 's1', cents: 12550 } })
    expect(planInlinePrice(svc(null), '25')).toMatchObject({ kind: 'save', cents: 2500 })
    expect(planInlinePrice(svc(5000), '$1,060')).toMatchObject({ kind: 'save', cents: 106000 })
    expect(planInlinePrice(svc(null), '0')).toMatchObject({ kind: 'save', cents: 0 })   // a typed 0 is a free service
  })

  it('the amount already saved sends nothing, however it is written', () => {
    for (const t of ['50', '50.00', '50.', '$50']) expect(planInlinePrice(svc(5000), t)).toEqual({ kind: 'none' })
  })

  it('text that is not an amount is refused and kept for correcting', () => {
    for (const t of ['abc', '12.5.0', '-5', '.', '1e3']) expect(planInlinePrice(svc(null), t)).toMatchObject({ kind: 'invalid', restore: false })
  })

  it('a saved price can be changed but not cleared — the saved amount goes back in the box', () => {
    expect(planInlinePrice(svc(5000), '')).toMatchObject({ kind: 'invalid', restore: true })
  })
})

describe('rebasePriceText — the box follows the server unless something else was typed', () => {
  it('an untouched box takes the new saved price', () => {
    expect(rebasePriceText('', '', '50.00', svc(5000))).toBe('50.00')
    expect(rebasePriceText('50.00', '50.00', '60.00', svc(6000))).toBe('60.00')
  })
  it('what was typed is tidied once that same amount is saved', () => {
    expect(rebasePriceText('25', '', '25.00', svc(2500))).toBe('25.00')
  })
  it('a different amount typed in the meantime is never overwritten', () => {
    expect(rebasePriceText('30', '', '25.00', svc(2500))).toBe('30')
    expect(rebasePriceText('abc', '', '25.00', svc(2500))).toBe('abc')
  })
  it('priceBoxText: saved amount with cents, empty while unpriced', () => {
    expect([priceBoxText(12550), priceBoxText(0), priceBoxText(null)]).toEqual(['125.50', '0.00', ''])
  })
})

describe('serialQueue — consecutive rows save one at a time, in order', () => {
  it('the second save starts only after the first has been answered', async () => {
    const run = serialQueue()
    const log: string[] = []
    let releaseFirst!: () => void
    const first = run(async () => { log.push('first sent'); await new Promise<void>((r) => { releaseFirst = r }); log.push('first answered'); return 1 })
    const second = run(async () => { log.push('second sent'); return 2 })
    await Promise.resolve(); await Promise.resolve()
    expect(log).toEqual(['first sent'])
    releaseFirst()
    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(log).toEqual(['first sent', 'first answered', 'second sent'])
  })

  it('a save that throws does not block the next one', async () => {
    const run = serialQueue()
    const bad = run(async () => { throw new Error('lost') })
    const good = run(async () => 'saved')
    await expect(bad).rejects.toThrow('lost')
    expect(await good).toBe('saved')
  })
})

describe('neighbourPriceBox — Tab goes to the next price box', () => {
  const boxes = ['wash', 'interior', 'wax']
  it('forward, backward, and nothing past either end (Tab then leaves the list normally)', () => {
    expect(neighbourPriceBox(boxes, 'interior', false)).toBe('wax')
    expect(neighbourPriceBox(boxes, 'interior', true)).toBe('wash')
    expect(neighbourPriceBox(boxes, 'wax', false)).toBeNull()
    expect(neighbourPriceBox(boxes, 'wash', true)).toBeNull()
    expect(neighbourPriceBox(boxes, 'gone', false)).toBeNull()
  })
})
