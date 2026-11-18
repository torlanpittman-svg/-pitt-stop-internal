'use client'

import { useEffect, useRef, useState } from 'react'
import ServiceRemoveConfirm from './ServiceRemoveConfirm'
import { startGesture, moveGesture, endGesture, idleGesture, isEditingTextEntryTarget, type GestureState } from './service-row-gesture'

/**
 * Shared service-line row: swipe LEFT to ask "Are you sure you want to remove this
 * line?" — the swipe itself never removes anything. The row takes the full width: there
 * is NO always-visible remove control, so prices sit flush on the right edge.
 *
 * Mouse/keyboard path (WCAG 2.5.1: never swipe-only) — one of:
 *   • the row's own editor (Estimate rows, guided Job services): tap/Enter opens the item
 *     editor, whose "Remove item" asks with the same warning. Nothing extra renders here;
 *   • `revealRemove` for rows that have NO editor (text-only Job services, the plain Job
 *     list, the Quick Entry selection): a "Remove" button that is invisible at rest, takes
 *     no layout space, and appears only on keyboard focus or mouse hover. It is always in
 *     the accessibility tree, and opens the SAME confirmation as the swipe.
 * Part rows and the Work Board VehicleCard keep the separate SwipeRow.
 */

/** A drag's ghost click is suppressed at most this long when the browser never fires
 *  one — a later deliberate click or key press must always work. */
const CLICK_SUPPRESS_MS = 400

/** Removable service rows inside one page's stable container, in document order. */
const rowsIn = (scope: Element) => Array.from(scope.querySelectorAll<HTMLElement>('[data-removable-service-row]'))
const revealButtonIn = (row: Element) => row.querySelector<HTMLElement>('[data-remove-service-button]')

export default function RemovableServiceRow({ children, serviceName, onRemove, busy = false, consequence, contentClassName = '', className = '', rounded = true, revealRemove = false, revealClassName = 'right-2', fallbackFocusSelector }: {
  children: React.ReactNode
  /** Shown in the confirmation and in the row's / Remove button's accessible name. */
  serviceName: string
  /** Runs ONLY after the user confirms (the dialog has already closed natively).
   *  Return false when the removal failed so focus and the row stay put; void/true
   *  counts as success. */
  onRemove: () => void | boolean | Promise<void | boolean>
  busy?: boolean
  /** Extra consequence line for the confirmation (e.g. which charges go with the line). */
  consequence?: string
  /** Styling for the swiped foreground (callers keep their own card look). */
  contentClassName?: string
  className?: string
  /** false inside a divided list card (the card owns the rounding). */
  rounded?: boolean
  /** The row has no editor of its own: render the hover/focus-revealed Remove button. */
  revealRemove?: boolean
  /** Where the revealed button sits (default: the row's right edge). Use it to keep the
   *  button off an interactive control such as an editable price. */
  revealClassName?: string
  /** Focused after a successful removal when no service row remains to receive focus
   *  (point it at the caller's stable Add-service control). */
  fallbackFocusSelector?: string
}) {
  const gesture = useRef<GestureState>(idleGesture)
  const suppressClick = useRef(false)
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removingRef = useRef(false)   // synchronous double-submit guard
  const rowRef = useRef<HTMLDivElement>(null)
  // true while the open confirmation came from the revealed button (mouse/keyboard); a
  // swipe leaves it false so a touch removal never pops the button into view.
  const viaButton = useRef(false)
  const [dx, setDx] = useState(0)
  // Mirrors gesture.current.phase === 'horizontal' for RENDER (transition on/off); the
  // decision machine itself stays in the ref so moves don't depend on render timing.
  const [dragging, setDragging] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [removing, setRemoving] = useState(false)

  // Ghost-click suppression is consume-once AND time-bounded: the browser may generate
  // no click at all for a real drag, so without the timeout the flag would silently eat
  // the next deliberate tap.
  const armSuppression = () => {
    suppressClick.current = true
    if (suppressTimer.current) clearTimeout(suppressTimer.current)
    suppressTimer.current = setTimeout(() => { suppressClick.current = false; suppressTimer.current = null }, CLICK_SUPPRESS_MS)
  }
  const clearSuppression = () => {
    suppressClick.current = false
    if (suppressTimer.current) { clearTimeout(suppressTimer.current); suppressTimer.current = null }
  }
  useEffect(() => () => { if (suppressTimer.current) clearTimeout(suppressTimer.current) }, [])

  const onTouchStart = (e: React.TouchEvent) => {
    clearSuppression()   // a new touch is a new intent — never eat its click
    gesture.current = startGesture(e.touches[0].clientX, e.touches[0].clientY, {
      busy: busy || removing || confirmOpen,
      multiTouch: e.touches.length > 1,
      // Only the field being edited (focused) keeps the drag for its caret; an unfocused
      // field is swipeable, so a row made entirely of fields can still be removed by touch.
      textEntryTarget: isEditingTextEntryTarget(e.target, document.activeElement),
    })
  }
  const onTouchMove = (e: React.TouchEvent) => {
    gesture.current = moveGesture(gesture.current, e.touches[0].clientX, e.touches[0].clientY, { multiTouch: e.touches.length > 1 })
    setDx(gesture.current.dx)
    setDragging(gesture.current.phase === 'horizontal')
  }
  const onTouchEnd = () => {
    const end = endGesture(gesture.current)
    gesture.current = idleGesture
    if (end.suppressClick) armSuppression()
    setDx(0)                     // the row always snaps back; nothing was removed
    setDragging(false)
    if (end.openConfirm) {
      // The swipe focused nothing, so give the dialog an invoker: native close will
      // then return focus to this row (not a control — nothing lights up on touch) on
      // Cancel/Escape and on confirm.
      viaButton.current = false
      rowRef.current?.focus({ preventScroll: true })
      setConfirmOpen(true)       // a completed swipe only ASKS
    }
  }
  const onTouchCancel = () => {
    // A cancelled horizontal drag can still produce a click — suppress that one too
    // (same bounded, consume-once rules), then snap back.
    if (endGesture(gesture.current).suppressClick) armSuppression()
    gesture.current = idleGesture
    setDx(0)
    setDragging(false)
  }

  // Confirmed removal. The dialog already closed (focus is back on its invoker: this
  // row, or its revealed Remove button). On success, focus continuity: with index-keyed
  // lists this same row now belongs to the next service; with stable-keyed lists this
  // row unmounts, so after the caller's state settles focus the row now holding this
  // position (the previous row when this was last, the caller's Add-service control
  // when none remain). A mouse/keyboard removal lands on that row's Remove button so
  // the next one is one key press away; a swipe lands on the row itself. The scope is
  // captured BEFORE the mutation and re-checked for connectedness, so a navigation in
  // the meantime is never yanked around. On failure the row stays, focus stays put,
  // and the caller's error UI explains — no second request is sent.
  const handleConfirm = () => {
    if (removingRef.current) return
    removingRef.current = true
    clearSuppression()   // the user explicitly chose in the modal — no ghost click can follow
    setRemoving(true)
    setConfirmOpen(false)
    const scope = rowRef.current?.closest('main') ?? null
    const myIndex = scope && rowRef.current ? rowsIn(scope).indexOf(rowRef.current) : -1
    const toButton = viaButton.current
    void (async () => {
      let removed = false
      try { removed = (await onRemove()) !== false } finally { removingRef.current = false; setRemoving(false) }
      if (removed && scope && myIndex >= 0) {
        requestAnimationFrame(() => {
          if (!scope.isConnected) return   // a different screen is up — leave its focus alone
          const rows = rowsIn(scope)
          const row = rows[Math.min(myIndex, rows.length - 1)]
          const target = row ? ((toButton && revealButtonIn(row)) || row)
            : (fallbackFocusSelector ? scope.querySelector<HTMLElement>(fallbackFocusSelector) : null)
          target?.focus()
        })
      }
    })()
  }

  const held = busy || removing

  return (
    // tabIndex -1: focusable by script only (the swipe's dialog invoker / post-removal
    // landing spot), never a Tab stop of its own.
    <div ref={rowRef} data-removable-service-row tabIndex={-1} role="group" aria-label={serviceName}
      className={`group/svc relative outline-none ${className}`} aria-busy={removing || undefined}>
      <div className={`relative overflow-hidden ${rounded ? 'rounded-2xl' : ''}`}>
        {/* Hint revealed while dragging. Purely visual — releasing past the threshold
            opens the confirmation; it is not a tappable action. */}
        {dx < 0 && (
          <div aria-hidden className={`absolute inset-y-0 right-0 flex items-center bg-red-600/90 px-4 text-sm font-semibold text-white ${rounded ? 'rounded-r-2xl' : ''}`}>
            Remove?
          </div>
        )}
        {/* Transition via classes (not inline style) so motion-reduce can disable the
            snap-back animation; while dragging the row follows the finger directly. */}
        <div
          className={`relative touch-pan-y ${dragging ? '' : 'transition-transform duration-200 ease-out motion-reduce:transition-none'} ${contentClassName}`}
          style={{ transform: `translateX(${dx}px)` }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchCancel}
          // A drag's ghost click (when the browser fires one) arrives straight after the
          // drag, with NO new pointerdown or keydown in between. So any new physical
          // pointer press (mouse, pen, next tap) or keyboard activation is deliberate —
          // clear the suppression before its click can be swallowed.
          onPointerDownCapture={clearSuppression}
          onKeyDownCapture={clearSuppression}
          // After a horizontal drag the browser may synthesize a click — swallow it once
          // so a swipe never also triggers the row's own tap action (e.g. tap-to-edit).
          onClickCapture={(e) => { if (suppressClick.current) { clearSuppression(); e.preventDefault(); e.stopPropagation() } }}
        >
          {children}
        </div>
      </div>
      {/* Editor-less rows only: the mouse/keyboard path to the SAME confirmation. Out of
          flow and invisible at rest (no reserved space, taps pass through to the row);
          shown on keyboard focus, and on hover where a real hover exists (Tailwind gates
          group-hover behind `@media (hover: hover)`, so it never sticks on touch). Hidden
          again while the user is typing in the row so it can't cover a field. Held via
          aria-disabled + click guard, not `disabled`, so it keeps focus while a removal
          is in flight (keyboard continuity depends on it staying focusable). */}
      {revealRemove && (
        <button type="button" data-remove-service-button
          onClick={() => { if (!held) { viaButton.current = true; setConfirmOpen(true) } }}
          aria-disabled={held || undefined}
          aria-label={`Remove ${serviceName}`}
          className={`absolute top-1/2 z-10 -translate-y-1/2 ${revealClassName} flex min-h-9 items-center rounded-lg border border-red-900 bg-gray-950 px-3 text-sm font-semibold text-red-300 shadow-lg pointer-events-none opacity-0 transition-opacity motion-reduce:transition-none group-hover/svc:pointer-events-auto group-hover/svc:opacity-100 group-has-[input:focus]/svc:pointer-events-none group-has-[input:focus]/svc:opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:bg-red-950 ${held ? 'text-red-300/40' : ''}`}>
          Remove
        </button>
      )}
      {confirmOpen && (
        <ServiceRemoveConfirm serviceName={serviceName} consequence={consequence} busy={busy}
          // Explicit dismissal: the original swipe's ghost click (if any) hit the modal,
          // so nothing is left to swallow — the next interaction must work immediately.
          onCancel={() => { clearSuppression(); setConfirmOpen(false) }}
          onConfirm={handleConfirm} />
      )}
    </div>
  )
}
