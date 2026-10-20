'use client'

/**
 * The tappable item rows shared by the Estimate / Invoice page and the Job page — one look, one
 * editor, the same records. Tap a row to edit it (ItemEditor); swipe left to reveal Remove (SwipeRow,
 * hidden at rest behind an opaque row). Read-only rows (cancelled estimate, no edit access) drop the
 * chevron, tap and swipe.
 */
import type { ReactNode } from 'react'
import SwipeRow from '@/app/components/SwipeRow'
import type { PartView, ServiceView } from './save-feedback'

const dollars = (c: number) => (c / 100).toFixed(2)

export function Chevron() {
  return <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-400"><path d="m9 18 6-6-6-6" /></svg>
}

/** One line: name, a short sub-line, the price (or what's missing), and — when editable — a chevron. */
export function Row({ id, label, title, badge, sub, price, attention, onOpen, onRemove, removeBusy }: {
  id: string; label: string; title: string; badge?: ReactNode; sub: ReactNode; price: ReactNode; attention?: string | null
  onOpen?: () => void; onRemove?: () => void; removeBusy?: boolean
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 min-w-0">{badge}<span className="font-semibold text-white break-words min-w-0">{title}</span></span>
        <span className="mt-0.5 block text-xs text-gray-400 break-words">{sub}</span>
        {attention && <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-amber-300"><span aria-hidden>●</span>{attention}</span>}
      </span>
      <span className="shrink-0 text-right tabular-nums">{price}</span>
    </>
  )
  if (!onOpen) return <li className="flex min-h-16 items-center gap-3 px-4 py-3">{body}</li>
  const button = (
    <button type="button" data-row={id} onClick={onOpen} aria-label={label}
      className="flex w-full min-h-16 items-center gap-3 bg-gray-900 px-4 py-3 text-left hover:bg-gray-800/60 active:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500">
      {body}
      <Chevron />
    </button>
  )
  // Opaque foreground (bg-gray-900) so the red Remove underneath shows only while swiping.
  return <li>{onRemove ? <SwipeRow onRemove={onRemove} busy={removeBusy} contentClassName="bg-gray-900" rounded={false}>{button}</SwipeRow> : button}</li>
}

export function serviceAttention(s: ServiceView): string | null {
  if (s.matchState === 'choose') return 'Choose the service'
  if (s.matchState === 'unmatched' && s.partLike) return s.partLike === 'part' ? 'Looks like a part' : 'Part or labor?'
  if (s.matchState === 'unmatched') return 'Not matched to a catalog service'
  return null
}

export function serviceSub(s: ServiceView): string {
  return [s.detail, s.matchState === 'custom' ? 'Custom service' : s.catalogName && s.catalogName !== s.title ? s.catalogName : null].filter(Boolean).join(' · ') || 'Service'
}

export function partSub(p: PartView): string {
  return [p.supply === 'customer' ? 'Customer-supplied' : 'Special order', `Qty ${p.quantity}`, p.supply === 'shop' && p.sellPriceCents != null && p.quantity !== 1 ? `$${dollars(p.sellPriceCents)} each` : null].filter(Boolean).join(' · ')
}

export function servicePrice(s: ServiceView, opts: { flat: boolean; readOnly: boolean }): ReactNode {
  return opts.flat ? <span className="text-gray-400 text-xs">In flat total</span>
    : s.priceCents != null ? <span className="font-semibold text-white">${dollars(s.priceCents)}</span>
    : opts.readOnly ? <span className="text-gray-400 text-sm">Not priced</span> : <span className="text-amber-300 text-sm font-semibold">Add price</span>
}

export function partPrice(p: PartView, opts: { readOnly: boolean }): ReactNode {
  return p.supply === 'customer' ? <span className="text-gray-400 text-sm">No charge</span>
    : p.lineCents != null ? <span className="font-semibold text-white">${dollars(p.lineCents)}</span>
    : opts.readOnly ? <span className="text-gray-400 text-sm">Not priced</span> : <span className="text-amber-300 text-sm font-semibold">Add price</span>
}

export const PART_BADGE = <span className="shrink-0 rounded-md bg-sky-900/50 px-1.5 py-0.5 text-[11px] font-semibold text-sky-200">Part</span>

export function ServiceRow({ s, flat, readOnly, onOpen, onRemove, busy }: {
  s: ServiceView; flat: boolean; readOnly: boolean; onOpen?: () => void; onRemove?: () => void; busy?: boolean
}) {
  return (
    <Row id={`svc:${s.id}`} label={`Edit ${s.title}`} title={s.title} sub={serviceSub(s)}
      attention={readOnly ? null : serviceAttention(s)} price={servicePrice(s, { flat, readOnly })}
      onOpen={readOnly ? undefined : onOpen} onRemove={readOnly ? undefined : onRemove} removeBusy={busy} />
  )
}

export function PartRow({ p, readOnly, onOpen, onRemove, busy }: {
  p: PartView; readOnly: boolean; onOpen?: () => void; onRemove?: () => void; busy?: boolean
}) {
  return (
    <Row id={`part:${p.id}`} label={`Edit part ${p.description}`} title={p.description} badge={PART_BADGE} sub={partSub(p)}
      attention={p.laborStatus === 'needs_review' ? 'Installation labor not reviewed' : null} price={partPrice(p, { readOnly })}
      onOpen={readOnly ? undefined : onOpen} onRemove={readOnly ? undefined : onRemove} removeBusy={busy} />
  )
}

/**
 * Swipe → Remove for a part. A part with linked installation labor must ask what happens to that
 * labor (PartRemoveConfirm), so its swipe opens the part editor with that question showing; a part
 * without labor is removed straight away, exactly like the editor's own Remove.
 */
export function partSwipeRemove(p: PartView, remove: () => void, openWithConfirm: () => void): () => void {
  return p.laborServiceId ? openWithConfirm : remove
}
