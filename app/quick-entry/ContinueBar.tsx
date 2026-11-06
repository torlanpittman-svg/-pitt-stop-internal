'use client'

import { useEffect, useRef, useState } from 'react'
import { blockerInputId, type Blocker } from './continue-gate'

/**
 * The fixed "Continue →" bar of the Details step. The button is ALWAYS tappable: tapping it with something
 * missing lists exactly what needs attention (and each line jumps to its field) instead of a silently
 * dimmed button. The parent decides what is missing with continueBlockers — one rule, no drift.
 *
 * The bar grows when the blocker list shows, so a fixed scroll padding cannot be right: an in-flow spacer
 * tracks the bar's REAL height, so on a phone the bottom fields (the saved-vehicle year/make/model editor)
 * can always scroll fully above the bar instead of sitting hidden behind it.
 */
export default function ContinueBar({ blockers, attempted, onContinue }: {
  blockers: Blocker[]
  /** The employee has tapped Continue at least once while something was missing. */
  attempted: boolean
  onContinue: () => void
}) {
  const show = attempted && blockers.length > 0
  const barRef = useRef<HTMLDivElement>(null)
  const [barHeight, setBarHeight] = useState(88)   // p-4 + h-14 button — the bar with no alert
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const measure = () => setBarHeight(el.offsetHeight || 88)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [show, blockers.length])
  const jump = (field: Blocker['field']) => {
    const el = typeof document === 'undefined' ? null : document.getElementById(blockerInputId(field))
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    if (el instanceof HTMLInputElement) el.focus({ preventScroll: true })
  }
  return (
    <>
      <div aria-hidden style={{ height: barHeight }} />
      <div ref={barRef} className="fixed bottom-0 inset-x-0 p-4 bg-gray-950/95 border-t border-gray-900">
        {show && (
          <div id="qe-continue-blockers" role="alert" aria-live="assertive" className="mb-3 rounded-xl border border-amber-700/60 bg-amber-950/40 px-3 py-2">
            <p className="text-amber-200 text-sm font-semibold">Before you continue:</p>
            <ul className="mt-1 space-y-1">
              {blockers.map((b) => (
                <li key={b.field}>
                  <button type="button" onClick={() => jump(b.field)} className="text-left text-amber-100 text-sm underline underline-offset-2 min-h-11 py-1">{b.message}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button type="button" onClick={onContinue} aria-describedby={show ? 'qe-continue-blockers' : undefined}
          className={`w-full h-14 rounded-2xl text-white text-lg font-bold ${blockers.length ? 'bg-blue-600/60 active:bg-blue-700' : 'bg-blue-600 active:bg-blue-700'}`}>
          Continue →
        </button>
      </div>
    </>
  )
}
