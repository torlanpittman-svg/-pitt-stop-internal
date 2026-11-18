/**
 * Pure state machine for the swipe-left gesture on removable service rows.
 * A COMPLETED left swipe only asks for confirmation — it never mutates. Keeping the
 * decisions here (axis lock, clamping, multi-touch/busy/text-input rejection, click
 * suppression) pure lets them be unit-tested in node without a DOM.
 */

/** Finger travel before the gesture commits to horizontal (swipe) or vertical (scroll). */
export const AXIS_LOCK_PX = 8
/** Leftward travel at release that counts as a completed swipe (opens the confirmation). */
export const CONFIRM_DISTANCE_PX = 64
/** Furthest the row visually follows the finger. */
export const MAX_PULL_PX = 96

export type GesturePhase =
  | 'idle'        // no touch in progress
  | 'pending'     // touching, axis not decided yet
  | 'horizontal'  // locked to the swipe; row follows the finger
  | 'rejected'    // scrolling / multi-touch / busy / started on a text field — ignore until release

export interface GestureState {
  phase: GesturePhase
  startX: number
  startY: number
  /** Clamped visual translation, always in [-MAX_PULL_PX, 0]. */
  dx: number
  /** The gesture locked horizontal at some point — even if it was later cancelled
   *  (multi-touch), any click the browser generates for it must be swallowed once. */
  wasHorizontal: boolean
}

export const idleGesture: GestureState = { phase: 'idle', startX: 0, startY: 0, dx: 0, wasHorizontal: false }

export interface GestureStartOptions {
  /** A removal is in flight or the row is disabled — don't start a new gesture. */
  busy?: boolean
  /** More than one touch point — this is a pinch/zoom, not a swipe. */
  multiTouch?: boolean
  /** The touch began on a text-entry element (input/select/textarea/contenteditable). */
  textEntryTarget?: boolean
}

export function startGesture(x: number, y: number, opts: GestureStartOptions = {}): GestureState {
  if (opts.busy || opts.multiTouch || opts.textEntryTarget) return { phase: 'rejected', startX: x, startY: y, dx: 0, wasHorizontal: false }
  return { phase: 'pending', startX: x, startY: y, dx: 0, wasHorizontal: false }
}

export function moveGesture(state: GestureState, x: number, y: number, opts: { multiTouch?: boolean } = {}): GestureState {
  if (state.phase === 'idle' || state.phase === 'rejected') return state
  // A second finger arriving mid-gesture cancels it (and snaps the row back).
  if (opts.multiTouch) return { ...state, phase: 'rejected', dx: 0 }
  const dx = x - state.startX
  const dy = y - state.startY
  if (state.phase === 'pending') {
    if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return state
    // Vertical or diagonal-mostly-vertical movement is a scroll — leave the page alone.
    if (Math.abs(dy) >= Math.abs(dx)) return { ...state, phase: 'rejected', dx: 0 }
    return { ...state, phase: 'horizontal', dx: clampPull(dx), wasHorizontal: true }
  }
  return { ...state, dx: clampPull(dx) }
}

export interface GestureEnd {
  /** The swipe completed — open the removal confirmation (nothing is removed yet). */
  openConfirm: boolean
  /** The finger dragged horizontally (even if the gesture was then cancelled), so a
   *  click the browser generates for it (e.g. the service checkoff) must be swallowed
   *  ONCE. The browser may also generate no click at all — the caller must bound the
   *  suppression so it never eats a later deliberate interaction. */
  suppressClick: boolean
}

export function endGesture(state: GestureState): GestureEnd {
  return {
    openConfirm: state.phase === 'horizontal' && state.dx <= -CONFIRM_DISTANCE_PX,
    suppressClick: state.wasHorizontal,
  }
}

/** Right swipes never build up travel; left swipes stop following at MAX_PULL_PX. */
function clampPull(dx: number): number {
  return Math.max(-MAX_PULL_PX, Math.min(0, dx))
}

/** True when a touch target is a text-entry element (or sits inside one) — swiping
 *  there would fight text selection and caret placement, so the gesture ignores it. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; closest?: (sel: string) => unknown } | null
  if (!el) return false
  const tag = (el.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  if (typeof el.closest === 'function') {
    return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
  }
  return false
}
