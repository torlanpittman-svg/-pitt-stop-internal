'use client'

import { useCallback, useEffect, useState } from 'react'
import { money } from '@/app/lib/format'

interface Part {
  id: string
  description: string
  partNumber: string | null
  brand: string | null
  supplier: string | null
  quantity: number
  unitCostCents: number | null
  sellPriceCents: number | null
  status: string
  supplierOrderNumber: string | null
  expectedArrival: string | null
  receivedQuantity: number
  outstandingQuantity: number
  isCore: boolean
  coreCreditCents: number | null
  returnedQuantity: number
  returnCreditCents: number | null
  waiting: boolean
  billed: boolean
  creditOutstanding: boolean
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  needed:             { label: 'Needed',            cls: 'bg-gray-800 text-gray-300' },
  ordered:            { label: 'Ordered',           cls: 'bg-blue-900/40 text-blue-300' },
  partially_received: { label: 'Partially received', cls: 'bg-amber-900/40 text-amber-300' },
  received:           { label: 'Received',          cls: 'bg-green-900/40 text-green-300' },
  cancelled:          { label: 'Cancelled',         cls: 'bg-red-900/40 text-red-300' },
}

function dollarsToCents(s: string): number | null {
  const n = Number(s)
  if (!Number.isFinite(n) || s.trim() === '') return null
  return Math.round(n * 100)
}

export default function PartsSection({ orderId }: { orderId: string }) {
  const [parts, setParts] = useState<Part[]>([])
  const [manager, setManager] = useState(false)
  const [visible, setVisible] = useState(true)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState<{ id: string; kind: 'order' | 'receive' | 'return' } | null>(null)

  useEffect(() => {
    let ok = true
    fetch(`/api/workflow/orders/${orderId}/parts`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!ok) return
        if (!d.ok) { setErr(d.error || 'Could not load parts.'); return }
        if (d.visible === false) { setVisible(false); return }
        setParts(d.parts); setManager(!!d.manager); setErr(null)
      })
      .catch(() => { if (ok) setErr('Network error loading parts.') })
      .finally(() => { if (ok) setLoading(false) })
    return () => { ok = false }
  }, [orderId])

  const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/workflow/orders/${orderId}/parts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) { setErr(d.error || 'Parts update failed.'); return false }
      setParts(d.parts); setManager(!!d.manager)
      return true
    } catch { setErr('Network error — please try again.'); return false }
    finally { setBusy(false) }
  }, [orderId])

  const waitingCount = parts.filter((p) => p.waiting).length

  // Backstop for the reversible rollout gate: if the server says parts aren't visible to this viewer,
  // render nothing (OrderDetail also gates mounting; this covers any direct mount). Data is preserved.
  if (!visible) return null

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-wider">
          Parts {waitingCount > 0 && <span className="text-amber-400 normal-case">· {waitingCount} waiting</span>}
        </h2>
        <button onClick={() => { setAdding((v) => !v); setMode(null) }} className="text-blue-400 text-sm font-semibold active:opacity-70">
          {adding ? 'Close' : '+ Add Part'}
        </button>
      </div>

      {err && <p className="text-red-400 text-sm mb-2">{err}</p>}

      {adding && <AddPartForm manager={manager} busy={busy} onAdd={async (b) => { if (await post({ action: 'add', ...b })) setAdding(false) }} />}

      {loading ? (
        <p className="text-gray-600 text-sm italic">Loading parts…</p>
      ) : parts.length === 0 ? (
        <p className="text-gray-600 text-sm italic">No parts tracked yet — tap ＋ Add Part.</p>
      ) : (
        <div className="space-y-2">
          {parts.map((p) => {
            const st = STATUS_STYLE[p.status] ?? { label: p.status, cls: 'bg-gray-800 text-gray-400' }
            const open = mode?.id === p.id
            return (
              <div key={p.id} className="rounded-2xl bg-gray-900 border border-gray-800 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-white font-semibold leading-tight">{p.description}</p>
                    <p className="text-xs text-gray-500 mt-0.5 break-words">
                      {[p.partNumber && `#${p.partNumber}`, p.brand, p.supplier].filter(Boolean).join(' · ') || 'No part details'}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Qty {p.quantity}
                      {p.receivedQuantity > 0 && ` · received ${p.receivedQuantity}`}
                      {p.outstandingQuantity > 0 && p.status !== 'needed' && ` · ${p.outstandingQuantity} outstanding`}
                      {p.returnedQuantity > 0 && ` · returned ${p.returnedQuantity}`}
                    </p>
                    {p.expectedArrival && p.status !== 'received' && (
                      <p className="text-xs text-amber-300/80 mt-0.5">Expected {p.expectedArrival}{p.supplierOrderNumber && ` · conf ${p.supplierOrderNumber}`}</p>
                    )}
                    {manager && (p.unitCostCents != null || p.sellPriceCents != null) && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        {p.unitCostCents != null && `Cost ${money(p.unitCostCents)}`}
                        {p.sellPriceCents != null && ` · Sell ${money(p.sellPriceCents)}`}
                      </p>
                    )}
                    {manager && (p.returnCreditCents || p.coreCreditCents) ? (
                      <p className="text-xs text-emerald-300/80 mt-0.5">
                        {p.returnCreditCents ? `Return credit ${money(p.returnCreditCents)}` : ''}
                        {p.coreCreditCents ? ` · Core credit ${money(p.coreCreditCents)}` : ''}
                      </p>
                    ) : null}
                    {/* Outstanding returns/core stay visible regardless of received status */}
                    {p.creditOutstanding && (
                      <p className="text-[11px] text-amber-300/90 mt-0.5">{p.isCore ? '● Core deposit outstanding' : '● Return credit pending'}</p>
                    )}
                    {/* Billing link status — explicit, so nothing is silently unbilled or double-billed */}
                    {p.status !== 'cancelled' && (
                      <p className="text-[11px] mt-0.5">
                        {p.billed ? <span className="text-emerald-400">On invoice</span> : <span className="text-gray-500">Not billed</span>}
                      </p>
                    )}
                  </div>
                  <span className={`flex-none text-[11px] font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                </div>

                {/* Actions */}
                {p.status !== 'cancelled' && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {(p.status === 'needed') && (
                      <button onClick={() => setMode(open && mode?.kind === 'order' ? null : { id: p.id, kind: 'order' })} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-900/40 text-blue-300 active:opacity-70">Mark ordered</button>
                    )}
                    {(p.status === 'ordered' || p.status === 'partially_received') && (
                      <button onClick={() => setMode(open && mode?.kind === 'receive' ? null : { id: p.id, kind: 'receive' })} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-900/40 text-green-300 active:opacity-70">Receive</button>
                    )}
                    {(p.receivedQuantity > 0 || p.status === 'received' || p.isCore) && (
                      <button onClick={() => setMode(open && mode?.kind === 'return' ? null : { id: p.id, kind: 'return' })} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 active:opacity-70">Return / core</button>
                    )}
                    {manager && !p.billed && (
                      <button
                        onClick={() => post({ action: 'bill', partId: p.id })}
                        disabled={busy || !(p.sellPriceCents && p.sellPriceCents > 0)}
                        title={p.sellPriceCents && p.sellPriceCents > 0 ? 'Create an invoice line for this part' : 'Set a sell price first'}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-900/40 text-emerald-300 active:opacity-70 disabled:opacity-40">Add to invoice</button>
                    )}
                    <button onClick={() => post({ action: 'cancel', partId: p.id })} disabled={busy} className="text-xs font-semibold px-3 py-1.5 rounded-lg text-red-400 active:opacity-70 disabled:opacity-40">Cancel</button>
                  </div>
                )}

                {open && mode?.kind === 'order' && (
                  <OrderForm busy={busy} defaultSupplier={p.supplier} onSubmit={(b) => post({ action: 'mark_ordered', partId: p.id, ...b }).then((ok) => ok && setMode(null))} />
                )}
                {open && mode?.kind === 'receive' && (
                  <ReceiveForm busy={busy} max={p.outstandingQuantity || p.quantity} onSubmit={(qty) => post({ action: 'receive', partId: p.id, receiveQuantity: qty }).then((ok) => ok && setMode(null))} />
                )}
                {open && mode?.kind === 'return' && (
                  <ReturnForm busy={busy} manager={manager} onSubmit={(b) => post({ action: 'return', partId: p.id, ...b }).then((ok) => ok && setMode(null))} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const inputCls = 'w-full rounded-lg bg-gray-950 border border-gray-800 px-3 py-2 text-sm outline-none focus:border-gray-600'

function AddPartForm({ manager, busy, onAdd }: { manager: boolean; busy: boolean; onAdd: (b: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ description: '', partNumber: '', supplier: '', quantity: '1', cost: '', sell: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-800 p-3 mb-2 space-y-2">
      <input className={inputCls} placeholder="Part description (required)" value={f.description} onChange={set('description')} />
      <div className="grid grid-cols-2 gap-2">
        <input className={inputCls} placeholder="Part number" value={f.partNumber} onChange={set('partNumber')} />
        <input className={inputCls} placeholder="Supplier" value={f.supplier} onChange={set('supplier')} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <input className={inputCls} inputMode="decimal" placeholder="Qty" value={f.quantity} onChange={set('quantity')} />
        {manager && <input className={inputCls} inputMode="decimal" placeholder="Unit cost $" value={f.cost} onChange={set('cost')} />}
        {manager && <input className={inputCls} inputMode="decimal" placeholder="Sell $" value={f.sell} onChange={set('sell')} />}
      </div>
      <button
        disabled={busy || !f.description.trim()}
        onClick={() => onAdd({
          description: f.description,
          partNumber: f.partNumber,
          supplier: f.supplier,
          quantity: Number(f.quantity) || 1,
          unitCostCents: manager ? dollarsToCents(f.cost) : undefined,
          sellPriceCents: manager ? dollarsToCents(f.sell) : undefined,
        })}
        className="w-full rounded-lg bg-blue-600 text-white font-semibold py-2.5 active:bg-blue-700 disabled:opacity-40"
      >
        Add part (saved as “Needed” — not ordered)
      </button>
    </div>
  )
}

function OrderForm({ busy, defaultSupplier, onSubmit }: { busy: boolean; defaultSupplier: string | null; onSubmit: (b: Record<string, unknown>) => void }) {
  const [supplier, setSupplier] = useState(defaultSupplier ?? '')
  const [conf, setConf] = useState('')
  const [arrival, setArrival] = useState('')
  const valid = supplier.trim() || conf.trim()
  return (
    <div className="mt-2.5 rounded-xl bg-gray-950 border border-gray-800 p-3 space-y-2">
      <p className="text-[11px] text-gray-500">Record the actual order. A supplier or confirmation number is required.</p>
      <input className={inputCls} placeholder="Supplier (NAPA, O'Reilly, dealer…)" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <input className={inputCls} placeholder="Order / confirmation #" value={conf} onChange={(e) => setConf(e.target.value)} />
        <input className={inputCls} type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} />
      </div>
      <button disabled={busy || !valid} onClick={() => onSubmit({ supplier, supplierOrderNumber: conf, expectedArrival: arrival || null })}
        className="w-full rounded-lg bg-blue-600 text-white font-semibold py-2.5 active:bg-blue-700 disabled:opacity-40">Confirm order placed</button>
    </div>
  )
}

function ReceiveForm({ busy, max, onSubmit }: { busy: boolean; max: number; onSubmit: (qty: number) => void }) {
  const [qty, setQty] = useState(String(max > 0 ? max : 1))
  return (
    <div className="mt-2.5 rounded-xl bg-gray-950 border border-gray-800 p-3 space-y-2">
      <p className="text-[11px] text-gray-500">How many just arrived? Partial deliveries are supported.</p>
      <input className={inputCls} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
      <button disabled={busy || !(Number(qty) > 0)} onClick={() => onSubmit(Number(qty))}
        className="w-full rounded-lg bg-green-600 text-white font-semibold py-2.5 active:bg-green-700 disabled:opacity-40">Receive {qty}</button>
    </div>
  )
}

function ReturnForm({ busy, manager, onSubmit }: { busy: boolean; manager: boolean; onSubmit: (b: Record<string, unknown>) => void }) {
  const [qty, setQty] = useState('1')
  const [credit, setCredit] = useState('')
  const [isCore, setIsCore] = useState(false)
  const [coreCredit, setCoreCredit] = useState('')
  return (
    <div className="mt-2.5 rounded-xl bg-gray-950 border border-gray-800 p-3 space-y-2">
      <p className="text-[11px] text-gray-500">Record a return and/or a core credit.</p>
      <div className="grid grid-cols-2 gap-2">
        <input className={inputCls} inputMode="decimal" placeholder="Return qty" value={qty} onChange={(e) => setQty(e.target.value)} />
        {manager && <input className={inputCls} inputMode="decimal" placeholder="Return credit $" value={credit} onChange={(e) => setCredit(e.target.value)} />}
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-300">
        <input type="checkbox" checked={isCore} onChange={(e) => setIsCore(e.target.checked)} /> Core charge
      </label>
      {isCore && manager && <input className={inputCls} inputMode="decimal" placeholder="Core credit $" value={coreCredit} onChange={(e) => setCoreCredit(e.target.value)} />}
      <button disabled={busy} onClick={() => onSubmit({
        returnQuantity: Number(qty) || 0,
        returnCreditCents: manager ? dollarsToCents(credit) : undefined,
        isCore,
        coreCreditCents: manager && isCore ? dollarsToCents(coreCredit) : undefined,
      })} className="w-full rounded-lg bg-gray-700 text-white font-semibold py-2.5 active:bg-gray-600 disabled:opacity-40">Record</button>
    </div>
  )
}
