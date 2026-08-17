'use client'

import { useState, useRef } from 'react'

/**
 * Shared swipe-left-to-remove row (mobile) with a subtle desktop hover/focus fallback.
 * Swipe reveals a red Remove; the user must deliberately tap it (a swipe alone never
 * deletes). Used by the simplified Estimate page and Job-detail services — one
 * implementation. `contentClassName` lets the caller style the foreground (the Estimate
 * card look) or leave it bare when the child provides its own styling (Job-detail rows).
 */
export default function SwipeRow({ children, onRemove, busy = false, contentClassName = '' }: {
  children: React.ReactNode
  onRemove: () => void
  busy?: boolean
  contentClassName?: string
}) {
  const [dx, setDx] = useState(0)
  const start = useRef<number | null>(null)
  const open = dx <= -44
  const onStart = (x: number) => { start.current = x }
  const onMove = (x: number) => { if (start.current != null) setDx(Math.max(-96, Math.min(0, x - start.current))) }
  const onEnd = () => { start.current = null; setDx((d) => (d <= -44 ? -88 : 0)) }

  return (
    <div className="relative overflow-hidden rounded-2xl group">
      {/* Red Remove revealed underneath on swipe */}
      <div className="absolute inset-y-0 right-0 flex items-stretch">
        <button onClick={onRemove} disabled={busy} aria-label="Remove"
          className="px-5 bg-red-600 text-white text-sm font-semibold active:bg-red-700 disabled:opacity-50">Remove</button>
      </div>
      {/* Foreground */}
      <div
        className={`relative touch-pan-y ${contentClassName}`}
        style={{ transform: `translateX(${dx}px)`, transition: start.current == null ? 'transform .18s ease' : 'none' }}
        onClick={() => { if (open) setDx(0) }}
        onTouchStart={(e) => onStart(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
        onTouchEnd={onEnd}
      >
        {children}
        {/* When open, a transparent layer captures the tap to close so it never triggers the row's own tap action. */}
        {open && <div className="absolute inset-0 z-10" onClick={(e) => { e.stopPropagation(); e.preventDefault(); setDx(0) }} />}
        {/* Desktop / keyboard fallback: subtle Remove on hover/focus — no permanent icon. */}
        <button onClick={onRemove} disabled={busy}
          className="hidden md:group-hover:block focus:block absolute top-1/2 -translate-y-1/2 right-3 z-20 text-xs bg-gray-900/90 text-gray-300 hover:text-red-400 border border-gray-700 rounded px-2 py-1">Remove</button>
      </div>
    </div>
  )
}
