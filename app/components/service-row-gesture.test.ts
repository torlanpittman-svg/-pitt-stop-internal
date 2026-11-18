/**
 * The swipe gesture itself must never remove anything: a completed left swipe only ASKS
 * (openConfirm), everything else — short/right/vertical/diagonal swipes, multi-touch,
 * busy rows, touches on text fields — must leave the row exactly as it was.
 */
import { describe, it, expect } from 'vitest'
import {
  startGesture, moveGesture, endGesture, idleGesture, isTextEntryTarget, isEditingTextEntryTarget,
  AXIS_LOCK_PX, CONFIRM_DISTANCE_PX, MAX_PULL_PX,
} from './service-row-gesture'

/** Drive a one-finger drag from (0,0) through the given points. */
function drag(points: Array<[number, number]>, opts: Parameters<typeof startGesture>[2] = {}) {
  let s = startGesture(0, 0, opts)
  for (const [x, y] of points) s = moveGesture(s, x, y)
  return s
}

describe('swipe-left gesture — only a completed left swipe asks for confirmation', () => {
  it('completed left swipe opens the confirmation (and suppresses the generated click)', () => {
    const s = drag([[-10, 0], [-40, 2], [-CONFIRM_DISTANCE_PX - 6, 3]])
    expect(s.phase).toBe('horizontal')
    expect(endGesture(s)).toEqual({ openConfirm: true, suppressClick: true })
  })

  it('short left swipe does NOT confirm, but still suppresses the click so tap-to-edit is not triggered', () => {
    const s = drag([[-10, 0], [-30, 1]])
    expect(endGesture(s)).toEqual({ openConfirm: false, suppressClick: true })
  })

  it('a tap (movement under the axis lock) neither confirms nor suppresses the click — tap-to-edit keeps working', () => {
    const s = drag([[-(AXIS_LOCK_PX - 2), 1]])
    expect(s.phase).toBe('pending')
    expect(endGesture(s)).toEqual({ openConfirm: false, suppressClick: false })
  })

  it('right swipe never builds travel and never confirms', () => {
    const s = drag([[20, 0], [80, 2]])
    expect(s.phase).toBe('horizontal')
    expect(s.dx).toBe(0)
    expect(endGesture(s).openConfirm).toBe(false)
  })

  it('vertical scroll is rejected — no translation, no confirmation, no click suppression', () => {
    const s = drag([[2, 30], [3, 120]])
    expect(s.phase).toBe('rejected')
    expect(s.dx).toBe(0)
    expect(endGesture(s)).toEqual({ openConfirm: false, suppressClick: false })
  })

  it('diagonal drag that is mostly vertical counts as scrolling, not swiping', () => {
    const s = drag([[-12, 14], [-40, 80]])
    expect(s.phase).toBe('rejected')
    expect(endGesture(s).openConfirm).toBe(false)
  })

  it('diagonal drag that is mostly horizontal counts as a swipe', () => {
    const s = drag([[-14, 10], [-CONFIRM_DISTANCE_PX - 10, 20]])
    expect(s.phase).toBe('horizontal')
    expect(endGesture(s).openConfirm).toBe(true)
  })

  it('a second finger at start rejects the gesture', () => {
    const s = startGesture(0, 0, { multiTouch: true })
    expect(s.phase).toBe('rejected')
    expect(endGesture(moveGesture(s, -200, 0)).openConfirm).toBe(false)
  })

  it('a second finger mid-swipe cancels and snaps the row back (dx reset)', () => {
    let s = drag([[-40, 0]])
    expect(s.dx).toBeLessThan(0)
    s = moveGesture(s, -60, 0, { multiTouch: true })
    expect(s.phase).toBe('rejected')
    expect(s.dx).toBe(0)
    expect(endGesture(s).openConfirm).toBe(false)
  })

  it('a cancelled horizontal drag still flags its possible ghost click for one-time suppression', () => {
    // The drag locked horizontal before the second finger arrived, so the browser may
    // still synthesize a click for it; it must never confirm, but must be swallowed once.
    let s = drag([[-40, 0]])
    s = moveGesture(s, -60, 0, { multiTouch: true })
    expect(endGesture(s)).toEqual({ openConfirm: false, suppressClick: true })
  })

  it('a drag that never locked horizontal carries no suppression when cancelled', () => {
    const s = drag([[2, 30]])   // vertical scroll, then (say) touchcancel
    expect(endGesture(s)).toEqual({ openConfirm: false, suppressClick: false })
  })

  it('busy rows ignore new swipes entirely', () => {
    const s = drag([[-200, 0]], { busy: true })
    expect(s.phase).toBe('rejected')
    expect(endGesture(s).openConfirm).toBe(false)
  })

  it('touches starting on a text field are ignored (typing/caret wins)', () => {
    const s = drag([[-200, 0]], { textEntryTarget: true })
    expect(s.phase).toBe('rejected')
    expect(endGesture(s).openConfirm).toBe(false)
  })

  it('translation is clamped to [-MAX_PULL_PX, 0]', () => {
    const far = drag([[-10, 0], [-500, 0]])
    expect(far.dx).toBe(-MAX_PULL_PX)
    const right = drag([[10, 0], [500, 0]])
    expect(right.dx).toBe(0)
  })

  it('idle state stays inert on stray moves', () => {
    expect(moveGesture(idleGesture, -300, 0)).toBe(idleGesture)
    expect(endGesture(idleGesture)).toEqual({ openConfirm: false, suppressClick: false })
  })
})

describe('isTextEntryTarget', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as EventTarget
  it.each(['INPUT', 'TEXTAREA', 'SELECT', 'input'])('detects %s elements', (tag) => {
    expect(isTextEntryTarget(el(tag))).toBe(true)
  })
  it('detects contenteditable elements', () => {
    expect(isTextEntryTarget(el('DIV', { isContentEditable: true }))).toBe(true)
  })
  it('detects descendants of text-entry elements via closest()', () => {
    expect(isTextEntryTarget(el('SPAN', { closest: (sel: string) => (sel.includes('input') ? {} : null) }))).toBe(true)
  })
  it('lets plain elements (e.g. the tap-to-edit button) through', () => {
    expect(isTextEntryTarget(el('BUTTON', { closest: () => null }))).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
  })
})

describe('isEditingTextEntryTarget (only the FOCUSED field blocks a swipe)', () => {
  const input = { tagName: 'INPUT' } as unknown as EventTarget
  const other = { tagName: 'INPUT' } as unknown as EventTarget
  it('blocks the swipe on the field being edited', () => {
    expect(isEditingTextEntryTarget(input, input)).toBe(true)
  })
  it('lets a swipe start on a field that is not focused (custom Quick Entry line: name + price inputs)', () => {
    expect(isEditingTextEntryTarget(input, null)).toBe(false)
    expect(isEditingTextEntryTarget(input, other)).toBe(false)
    expect(isEditingTextEntryTarget(input, { tagName: 'BODY' })).toBe(false)
  })
  it('blocks a touch inside a focused editable region', () => {
    const region = { tagName: 'DIV' }
    const child = { tagName: 'SPAN', closest: () => region } as unknown as EventTarget
    expect(isEditingTextEntryTarget(child, region)).toBe(true)
    expect(isEditingTextEntryTarget(child, {})).toBe(false)
  })
  it('never blocks non-text targets', () => {
    const btn = { tagName: 'BUTTON', closest: () => null } as unknown as EventTarget
    expect(isEditingTextEntryTarget(btn, btn)).toBe(false)
    expect(isEditingTextEntryTarget(null, null)).toBe(false)
  })
})
