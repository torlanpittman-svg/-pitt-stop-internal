'use client'

/**
 * One service on the Job screen with its price typed in place: the name (which still opens the item
 * editor) and a compact dollar box on the right. Type the amount and press Enter, Tab or tap away —
 * it saves and you stay on the Job. Tab goes straight to the next service's price box.
 *
 * The box sends the SAME edit as the item editor's Price field (`set_service_price`, planned by
 * planInlinePrice → planServiceSave), so validation, permissions, the QuickBooks "sync needed" flag and
 * the totals are the server's, exactly as before. Nothing is priced here.
 *   • blank on an unpriced service = still unpriced (nothing is sent; never $0);
 *   • a save that fails keeps what was typed and shows the reason under the row, with Try again;
 *   • the box is never disabled while a save is running, so typing in the next row is never interrupted.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ServiceView } from './estimate/save-feedback'
import { neighbourPriceBox, planInlinePrice, priceBoxText, rebasePriceText } from './estimate/inline-price'

export type SavePrice = (serviceId: string, cents: number) => Promise<{ ok: true } | { ok: false; error: string }>

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; msg: string; retry: boolean }

export default function ServicePriceLine({ s, name, onSave }: {
  s: ServiceView
  /** The service's name control (the button that opens its editor). */
  name: ReactNode
  onSave: SavePrice
}) {
  const ids = useId()
  const server = priceBoxText(s.priceCents)
  const [text, setText] = useState(server)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // Follow the server's price for a box the user hasn't typed over (see rebasePriceText).
  const [prevServer, setPrevServer] = useState(server)
  if (server !== prevServer) { setPrevServer(server); setText((t) => rebasePriceText(t, prevServer, server, s)) }

  const live = useRef({ s, text, onSave })
  useLayoutEffect(() => { live.current = { s, text, onSave } })
  /** The amount now on its way to the server (Enter followed by leaving the box must not send it twice). */
  const sending = useRef<number | null>(null)
  const attempt = useRef(0)

  useEffect(() => {
    if (status.kind !== 'saved') return
    const t = setTimeout(() => setStatus((x) => (x.kind === 'saved' ? { kind: 'idle' } : x)), 2000)
    return () => clearTimeout(t)
  }, [status])

  const commit = async () => {
    const { s: saved, text: typed } = live.current
    // Compare with what the server WILL hold: an amount already on its way counts as this row's price,
    // so a different amount typed before the answer arrives is sent after it, and the same one is not re-sent.
    const svc = sending.current != null ? { ...saved, priceCents: sending.current } : saved
    const plan = planInlinePrice(svc, typed)
    if (plan.kind === 'invalid') {
      if (plan.restore) setText(priceBoxText(svc.priceCents))
      setStatus({ kind: 'error', msg: plan.error, retry: false })
      return
    }
    if (plan.kind === 'none') {
      // Untouched / unchanged: tidy the text ("50" → "50.00") and drop a stale message. Nothing is sent.
      if (sending.current == null) { setText(priceBoxText(svc.priceCents)); setStatus((x) => (x.kind === 'error' ? { kind: 'idle' } : x)) }
      return
    }
    sending.current = plan.cents
    const mine = ++attempt.current
    setStatus({ kind: 'saving' })
    const out = await live.current.onSave(svc.id, plan.cents)
    if (mine !== attempt.current) return   // a newer amount for this row is in flight; its answer decides
    sending.current = null
    setStatus(out.ok ? { kind: 'saved' } : { kind: 'error', msg: out.error, retry: true })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void commit(); e.currentTarget.select(); return }
    if (e.key === 'Escape') { setText(priceBoxText(live.current.s.priceCents)); setStatus({ kind: 'idle' }); return }
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return
    // Tab = save (leaving the box does that) and go straight to the next service's price box.
    const next = neighbourPriceBox(Array.from(document.querySelectorAll<HTMLInputElement>('input[data-service-price]')), e.currentTarget, e.shiftKey)
    if (next) { e.preventDefault(); next.focus() }
  }

  const unpriced = s.priceCents == null && text.trim() === ''
  const tone = status.kind === 'error' ? 'border-red-500 focus:border-red-400'
    : status.kind === 'saving' ? 'border-blue-500/70 focus:border-blue-400'
    : status.kind === 'saved' ? 'border-emerald-500/80 focus:border-emerald-400'
    : unpriced ? 'border-amber-500/70 focus:border-blue-500' : 'border-gray-700 focus:border-blue-500'

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        {name}
        <span className="relative block w-28 shrink-0">
          <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
          <input data-service-price={s.id} aria-label={`Price for ${s.title}`}
            aria-invalid={status.kind === 'error' || undefined} aria-describedby={status.kind === 'error' ? `${ids}-err` : undefined}
            value={text} onChange={(e) => { setText(e.target.value); setStatus((x) => (x.kind === 'error' && !x.retry ? { kind: 'idle' } : x)) }}
            onFocus={(e) => e.currentTarget.select()} onBlur={() => void commit()} onKeyDown={onKeyDown}
            type="text" inputMode="decimal" enterKeyHint="done" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="0.00"
            className={`h-11 w-full rounded-xl border bg-gray-950 pl-7 pr-3 text-right text-base font-semibold tabular-nums text-white placeholder:font-normal placeholder:text-gray-500 focus:outline-none ${tone}`} />
        </span>
      </div>
      {/* Saving / saved are announced without moving the rows; only a problem takes a line of its own. */}
      <span role="status" aria-live="polite" className="sr-only">
        {status.kind === 'saving' ? `Saving the price for ${s.title}…` : status.kind === 'saved' ? `Price for ${s.title} saved.` : ''}
      </span>
      {status.kind === 'error' && (
        <p id={`${ids}-err`} role="alert" className="mt-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-right text-sm text-red-300">
          <span className="min-w-0 break-words">{status.retry ? `Price not saved — ${status.msg}` : status.msg}</span>
          {status.retry && (
            <button type="button" onClick={() => void commit()} className="min-h-11 shrink-0 rounded-lg border border-red-500/70 px-3 text-sm font-semibold text-red-200 active:opacity-70">Try again</button>
          )}
        </p>
      )}
    </div>
  )
}
