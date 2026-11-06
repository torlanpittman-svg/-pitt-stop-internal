/**
 * The Details-step Continue bar never silently disables: static markup (project convention, no DOM)
 * pins that the button is always enabled and that, once tapped with something missing, every reason
 * is on screen.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ContinueBar from './ContinueBar'
import type { Blocker } from './continue-gate'

const blockers: Blocker[] = [
  { field: 'year', message: 'The year must be 4 digits — "19" is not.' },
  { field: 'model', message: 'Enter the vehicle model.' },
]
const continueButton = (html: string) => html.match(/<button[^>]*>Continue →<\/button>/)?.[0] ?? ''

describe('ContinueBar', () => {
  it('the Continue button is never rendered disabled, even with blockers', () => {
    for (const attempted of [false, true]) {
      const html = renderToStaticMarkup(<ContinueBar blockers={blockers} attempted={attempted} onContinue={() => {}} />)
      expect(continueButton(html)).not.toBe('')
      expect(continueButton(html)).not.toContain('disabled')
    }
  })
  it('before the first tap nothing is shouted; after a tap every blocker is listed as an alert', () => {
    const quiet = renderToStaticMarkup(<ContinueBar blockers={blockers} attempted={false} onContinue={() => {}} />)
    expect(quiet).not.toContain('Before you continue')
    const loud = renderToStaticMarkup(<ContinueBar blockers={blockers} attempted onContinue={() => {}} />)
    expect(loud).toContain('role="alert"')
    expect(loud).toContain('The year must be 4 digits — &quot;19&quot; is not.')
    expect(loud).toContain('Enter the vehicle model.')
  })
  it('with nothing missing the alert is absent even after an attempt', () => {
    const html = renderToStaticMarkup(<ContinueBar blockers={[]} attempted onContinue={() => {}} />)
    expect(html).not.toContain('role="alert"')
  })
  it('reserves in-flow space for the fixed bar so it cannot cover the fields above it', () => {
    const html = renderToStaticMarkup(<ContinueBar blockers={blockers} attempted onContinue={() => {}} />)
    expect(html).toMatch(/aria-hidden="true" style="height:\d+px"/)
  })
})
