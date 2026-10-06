import type { ReactNode } from 'react'
import { cn } from './cn'

/*
 * Badge — status/label pill. Unifies the 15+ inline badge definitions onto one
 * semantic vocabulary that matches the CFO color language:
 *   positive=emerald  warn=amber  tight=orange  critical/danger=red
 *   info=sky  brand=blue  neutral=gray
 */
export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'positive'
  | 'warn'
  | 'tight'
  | 'danger'
  | 'info'

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-gray-800 text-gray-300 border-gray-700',
  brand: 'bg-blue-950/40 text-blue-300 border-blue-900/60',
  positive: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
  warn: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  tight: 'bg-orange-950/30 text-orange-300 border-orange-900/60',
  danger: 'bg-red-950/40 text-red-300 border-red-900/60',
  info: 'bg-sky-950/40 text-sky-300 border-sky-900/60',
}

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
