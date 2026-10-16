/**
 * Shared navigation touch targets: Back, Search, and Home are each at least 44×44 CSS px
 * (Tailwind min-h-11 / min-w-11) and keep their accessible names. Rendered server-side, no DOM.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import NavHeader from './NavHeader'

const html = renderToStaticMarkup(<NavHeader back={{ href: '/estimates', label: 'Estimates' }} />)
const tag = (re: RegExp) => html.match(re)?.[0] ?? ''

describe('NavHeader touch targets', () => {
  it('Back link is at least 44×44 and still points at its known parent', () => {
    const back = tag(/<a[^>]*href="\/estimates"[^>]*>/)
    expect(back).toMatch(/min-h-11/)
    expect(back).toMatch(/min-w-11/)
    expect(html).toContain('Estimates')
  })
  it('Home link is at least 44×44 with its accessible name', () => {
    const home = tag(/<a[^>]*aria-label="Home"[^>]*>/)
    expect(home).toMatch(/href="\/"/)
    expect(home).toMatch(/min-h-11/)
    expect(home).toMatch(/min-w-11/)
  })
  it('Search button is at least 44×44 with its accessible name', () => {
    const search = tag(/<button[^>]*aria-label="Search"[^>]*>/)
    expect(search).toMatch(/min-h-11/)
    expect(search).toMatch(/min-w-11/)
  })
})
