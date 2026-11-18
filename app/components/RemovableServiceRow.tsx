'use client'

import { useEffect, useRef, useState } from 'react'
import ServiceRemoveConfirm from './ServiceRemoveConfirm'
import { startGesture, moveGesture, endGesture, idleGesture, isTextEntryTarget, type GestureState } from './service-row-gesture'

/**
 * Shared service-line row: swipe LEFT to ask "Are you sure you want to remove this
 * line?" — the swipe itself never removes anything — plus a compact, always-available
 * labeled ✕ button as the mouse/keyboard path (≥44px target, sits beside the row so it
 * never overlaps names or prices). Replaces the old always-visible "Remove service"
 * text for service lists (Job detail, guided Job items, Estimate, Quick Entry
 * selection). Part rows and the Work Board VehicleCard keep the separate SwipeRow.
 */

/** A drag's ghost click is suppressed at most this long when the browser never fires
 *  one — a later deliberate click or key press must always work. */
const CLICK_SUPPRESS_MS = 400

/** Service-remove triggers inside one page's stable container, in document order. */
const removeButtonsIn = (scope: Element) => Array.from(scope.querySelectorAll<HTMLElement>('[data-remove-service-button]'))

export default function RemovableServiceRow({ children, serviceName, onRemove, busy = false, consequence, contentClassName = '', className = '', rounded = true, fallbackFocusSelector }: {
  children: React.ReactNode
  /** Shown in the confirmation and in the ✕ button's accessible name. */
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
  /** Focused after a successful removal when no service row remains to receive focus
   *  (point it at the caller's stable Add-service control). */
  fallbackFocusSelector?: string
}) {
  const gesture = useRef<GestureState>(idleGesture)
  const suppressClick = useRef(false)
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removingRef = useRef(false)   // synchronous double-submit guard
  const btnRef = useRef<HTMLButtonElement>(null)
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
      textEntryTarget: isTextEntryTarget(e.target),
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
      // then return focus to this row's ✕ on Cancel/Escape and on confirm.
      btnRef.current?.focus()
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

  // Confirmed removal. The dialog already closed (focus is back on this row's ✕). On
  // success, keyboard continuity: with index-keyed lists this same button now belongs
  // to the next service; with stable-keyed lists this row unmounts, so after the
  // caller's state settles focus the button now holding this position (the previous
  // row when this was last, the caller's Add-service control when none remain). The
  // scope is captured BEFORE the mutation and re-checked for connectedness, so a
  // navigation in the meantime is never yanked around. On failure the row stays,
  // focus stays on ✕, and the caller's error UI explains — no second request is sent.
  const handleConfirm = () => {
    if (removingRef.current) return
    removingRef.current = true
    clearSuppression()   // the user explicitly chose in the modal — no ghost click can follow
    setRemoving(true)
    setConfirmOpen(false)
    const scope = btnRef.current?.closest('main') ?? null
    const myIndex = scope && btnRef.current ? removeButtonsIn(scope).indexOf(btnRef.current) : -1
    void (async () => {
      let removed = false
      try { removed = (await onRemove()) !== false } finally { removingRef.current = false; setRemoving(false) }
      if (removed && scope && myIndex >= 0) {
        requestAnimationFrame(() => {
          if (!scope.isConnected) return   // a different screen is up — leave its focus alone
          const buttons = removeButtonsIn(scope)
          const target = buttons[Math.min(myIndex, buttons.length - 1)]
            ?? (fallbackFocusSelector ? scope.querySelector<HTMLElement>(fallbackFocusSelector) : null)
          target?.focus()
        })
      }
    })()
  }

  const held = busy || removing

  return (
    <div className={`flex items-center gap-2 ${className}`} aria-busy={removing || undefined}>
      <div className={`relative flex-1 min-w-0 overflow-hidden ${rounded ? 'rounded-2xl' : ''}`}>
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
      {/* Mouse/keyboard path to the SAME confirmation (WCAG 2.5.1: never swipe-only).
          Held via aria-disabled + click guard, not `disabled`, so it keeps focus while a
          removal is in flight (keyboard continuity depends on it staying focusable). */}
      <button ref={btnRef} type="button" data-remove-service-button
        onClick={() => { if (!held) setConfirmOpen(true) }}
        aria-disabled={held || undefined}
        aria-label={`Remove ${serviceName}`} title={`Remove ${serviceName}`}
        className={`shrink-0 flex items-center justify-center min-h-11 min-w-11 rounded-xl border border-gray-800 bg-gray-900 text-gray-500 transition-colors motion-reduce:transition-none hover:text-red-300 hover:border-red-800 focus-visible:text-red-300 active:text-red-300 ${held ? 'opacity-40' : ''}`}>
        <span aria-hidden>✕</span>
      </button>
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
