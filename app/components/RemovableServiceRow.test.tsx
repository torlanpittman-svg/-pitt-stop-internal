/**
 * Service rows carry NO always-visible remove control (the ✕ beside each price is gone), so the
 * row — and its price — takes the full width. Rows that open an editor render nothing extra (the
 * editor's "Remove item" is the mouse/keyboard path); rows without an editor render a Remove button
 * that is invisible and out of flow at rest and shows only on keyboard focus / mouse hover.
 * Rendered server-side, no DOM — swipe, dialog and focus behavior are exercised in the browser.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import RemovableServiceRow from './RemovableServiceRow'
import { ServiceRow } from '@/app/orders/[id]/estimate/ItemRows'
import type { ServiceView } from '@/app/orders/[id]/estimate/save-feedback'

const row = (props: Partial<Parameters<typeof RemovableServiceRow>[0]> = {}) => renderToStaticMarkup(
  <RemovableServiceRow serviceName="Interior Detail" onRemove={() => {}} {...props}>
    <span>Interior Detail</span><span>$200.00</span>
  </RemovableServiceRow>,
)
const removeButton = (html: string) => html.match(/<button[^>]*data-remove-service-button[^>]*>/)?.[0] ?? ''

describe('RemovableServiceRow — no persistent remove control', () => {
  it('a row with an editor renders no remove button and no ✕ at all', () => {
    const html = row()
    expect(html).not.toContain('<button')
    expect(html).not.toContain('✕')
    expect(html).not.toMatch(/aria-label="Remove /)
  })

  it('reserves no space beside the content (no flex gutter, no side padding)', () => {
    const html = row()
    const outer = html.match(/<div[^>]*data-removable-service-row[^>]*>/)?.[0] ?? ''
    expect(outer).not.toMatch(/\bflex\b|gap-2|pr-2/)
  })

  it('the row is a script-only focus target named after the service (swipe invoker / landing spot)', () => {
    const outer = row().match(/<div[^>]*data-removable-service-row[^>]*>/)?.[0] ?? ''
    expect(outer).toMatch(/tabindex="-1"/)
    expect(outer).toMatch(/role="group"/)
    expect(outer).toMatch(/aria-label="Interior Detail"/)
  })

  it('an editor-less row gets a named Remove button that is hidden and out of flow at rest', () => {
    const btn = removeButton(row({ revealRemove: true }))
    expect(btn).toMatch(/aria-label="Remove Interior Detail"/)
    expect(btn).toMatch(/\babsolute\b/)                  // takes no layout space
    expect(btn).toMatch(/(^|[\s"])opacity-0\b/)          // invisible at rest
    expect(btn).toMatch(/(^|[\s"])pointer-events-none\b/) // taps pass through to the row
    expect(btn).toMatch(/focus-visible:opacity-100/)     // keyboard
    expect(btn).toMatch(/focus-visible:pointer-events-auto/)
    expect(btn).toMatch(/group-hover\/svc:opacity-100/)  // mouse
    expect(btn).not.toMatch(/\sdisabled(=|\s|>)/)        // stays focusable (aria-disabled when held)
    expect(row({ revealRemove: true })).not.toContain('✕')
  })

  it('the revealed button can be positioned off an interactive price', () => {
    expect(removeButton(row({ revealRemove: true, revealClassName: 'right-[6.5rem]' }))).toMatch(/right-\[6\.5rem\]/)
  })

  it('nothing is confirmed or removed by rendering (the dialog is closed at rest)', () => {
    expect(row({ revealRemove: true, consequence: 'Its charge will also be removed.' })).not.toContain('<dialog')
  })
})

describe('Estimate service row', () => {
  const s = { id: 's1', title: 'Wax', priceCents: 10000, matchState: 'matched' } as unknown as ServiceView
  const html = renderToStaticMarkup(<ul><ServiceRow s={s} flat={false} readOnly={false} onOpen={() => {}} onConfirmedRemove={() => true} consequence="x" /></ul>)

  it('keeps tap-to-edit (the editor holds Remove item) and adds no per-row remove control', () => {
    expect(html).toMatch(/<button[^>]*aria-label="Edit Wax"/)
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toContain('✕')
    expect(html).not.toContain('data-remove-service-button')
  })
  it('is still a swipeable removable row with the price shown', () => {
    expect(html).toContain('data-removable-service-row')
    expect(html).toContain('$100.00')
    expect(html).not.toMatch(/pr-2/)
  })
})
