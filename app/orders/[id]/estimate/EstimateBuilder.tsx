'use client'

import { useState, useCallback } from 'react'
import NavHeader from '@/app/components/NavHeader'

type LineType = 'labor' | 'part' | 'fee' | 'sublet'
type Approval = 'pending' | 'approved' | 'declined' | 'deferred'
interface Line { id: string; type: string; name: string; qty: string; unit: string; costCents: number; priceCents: number; taxable: boolean; taxCategory: string }
interface Service { id: string; title: string; approvalState: string; technician: string | null; lines: Line[] }
interface Estimate { id: string; status: string; taxRateBps: number; taxableSubtotalCents: number; nontaxableSubtotalCents: number; taxCents: number; totalCents: number; needsTaxReview: boolean }
interface Full { estimate: Estimate | null; services: Service[] }
interface Header { id: string; customer: string; vehicle: string; requested: string[] }

const TAX_CATS = ['repair_parts', 'mechanical_labor', 'taxable_consumable', 'remodeling', 'detailing', 'collision', 'exempt', 'fee', 'sublet', 'review', 'other']
const fmt = (c: number) => `$${((c || 0) / 100).toFixed(2)}`
const amt = (l: Line) => Math.round(l.priceCents * (parseFloat(l.qty) || 0))
const defForType = (t: LineType) => t === 'part' ? { taxable: true, taxCategory: 'repair_parts' } : t === 'labor' ? { taxable: false, taxCategory: 'mechanical_labor' } : { taxable: false, taxCategory: 'review' }

const APPROVAL_STYLE: Record<Approval, string> = { approved: 'bg-green-600', declined: 'bg-red-600', deferred: 'bg-amber-600', pending: 'bg-gray-700' }
const inputCls = 'bg-gray-800 border border-gray-700 text-white rounded-lg px-2 py-1.5 text-sm'

function AddLineForm({ onAdd }: { onAdd: (l: { type: LineType; name: string; qty: number; priceCents: number; costCents: number; taxable: boolean; taxCategory: string }) => void }) {
  const [type, setType] = useState<LineType>('labor')
  const [name, setName] = useState('')
  const [qty, setQty] = useState('1')
  const [price, setPrice] = useState('')
  const [cost, setCost] = useState('')
  const [taxable, setTaxable] = useState(false)
  const [cat, setCat] = useState('mechanical_labor')
  const setT = (t: LineType) => { setType(t); const d = defForType(t); setTaxable(d.taxable); setCat(d.taxCategory) }
  return (
    <div className="mt-2 grid grid-cols-2 md:grid-cols-8 gap-2 items-center bg-gray-950/40 rounded-xl p-2">
      <select value={type} onChange={(e) => setT(e.target.value as LineType)} className={inputCls}>
        <option value="labor">Labor</option><option value="part">Part</option><option value="fee">Fee</option><option value="sublet">Sublet</option>
      </select>
      <input className={`${inputCls} md:col-span-2`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className={inputCls} placeholder={type === 'labor' ? 'Hours' : 'Qty'} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input className={inputCls} placeholder="Price $" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      <input className={inputCls} placeholder="Cost $" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
      <label className="flex items-center gap-1 text-xs text-gray-300"><input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} /> Tax</label>
      <select value={cat} onChange={(e) => setCat(e.target.value)} className={`${inputCls} text-xs`}>{TAX_CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
      <button onClick={() => { if (!name.trim()) return; onAdd({ type, name: name.trim(), qty: parseFloat(qty) || 0, priceCents: Math.round((parseFloat(price) || 0) * 100), costCents: Math.round((parseFloat(cost) || 0) * 100), taxable, taxCategory: cat }); setName(''); setQty('1'); setPrice(''); setCost('') }}
        className="md:col-span-8 bg-blue-600 text-white text-sm font-semibold rounded-lg py-2 active:bg-blue-700">+ Add line</button>
    </div>
  )
}

export default function EstimateBuilder({ header, initial }: { header: Header; initial: Full | null }) {
  const [data, setData] = useState<Full>(initial ?? { estimate: null, services: [] })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [newSvc, setNewSvc] = useState('')

  const post = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${header.id}/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Action failed'); return d }
      setData({ estimate: d.estimate ?? null, services: d.services ?? [] })
      return d
    } catch { setErr('Network error'); return null } finally { setBusy(false) }
  }, [header.id])

  const est = data.estimate
  const taxPct = est ? (est.taxRateBps / 100).toFixed(2) : '8.25'

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <NavHeader back={{ href: `/orders/${header.id}`, label: 'Job' }} />
      <div className="max-w-4xl mx-auto px-5 py-6">
        <div className="mt-1 mb-4">
          <h1 className="text-2xl font-bold">Estimate</h1>
          <p className="text-gray-400">{header.customer} · {header.vehicle}</p>
          {header.requested.length > 0 && <p className="text-gray-600 text-xs mt-1">Requested: {header.requested.join(', ')}</p>}
        </div>
        {err && <p className="text-red-400 text-sm mb-3">{err}</p>}

        {!est ? (
          <button onClick={() => post({ action: 'build' })} disabled={busy}
            className="w-full h-14 rounded-2xl bg-blue-600 text-white text-lg font-bold disabled:opacity-40">
            {busy ? 'Starting…' : 'Start estimate (promote requested services)'}
          </button>
        ) : (
          <>
            {/* Status + actions */}
            <div className="flex items-center flex-wrap gap-2 mb-4">
              <span className="text-xs uppercase tracking-wide bg-gray-800 border border-gray-700 rounded-full px-3 py-1">{est.status.replace(/_/g, ' ')}</span>
              <button onClick={() => post({ action: 'set_status', status: 'ready_to_send' })} className="text-xs text-gray-300 border border-gray-700 rounded-full px-3 py-1">Ready to send</button>
              <button onClick={() => post({ action: 'set_status', status: 'sent' })} className="text-xs text-gray-300 border border-gray-700 rounded-full px-3 py-1">Mark sent</button>
              <button onClick={() => post({ action: 'convert' })} className="text-xs text-white bg-green-700 rounded-full px-3 py-1">Convert to work</button>
              <a href={`/orders/${header.id}/estimate/print`} target="_blank" className="text-xs text-blue-400 underline ml-auto">Printable summary ↗</a>
            </div>

            {/* Services */}
            <div className="space-y-4">
              {data.services.map((s) => (
                <div key={s.id} className="rounded-2xl bg-gray-900 border border-gray-800 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <p className="font-semibold flex-1">{s.title}</p>
                    <button onClick={() => post({ action: 'remove_service', serviceId: s.id })} className="text-gray-600 text-sm">Remove</button>
                  </div>
                  <div className="flex gap-1.5 mb-3">
                    {(['approved', 'declined', 'deferred', 'pending'] as Approval[]).map((a) => (
                      <button key={a} onClick={() => post({ action: 'set_approval', serviceId: s.id, state: a })}
                        className={`text-[11px] rounded-full px-2.5 py-1 capitalize ${s.approvalState === a ? APPROVAL_STYLE[a] + ' text-white' : 'bg-gray-800 text-gray-400 border border-gray-700'}`}>{a}</button>
                    ))}
                  </div>
                  {s.lines.length > 0 && (
                    <div className="space-y-1">
                      {s.lines.map((l) => (
                        <div key={l.id} className="flex items-center gap-2 text-sm text-gray-300 bg-gray-950/40 rounded-lg px-2 py-1.5">
                          <span className="text-[10px] uppercase text-gray-500 w-12">{l.type}</span>
                          <span className="flex-1 truncate">{l.name}</span>
                          <span className="text-gray-500 text-xs">{parseFloat(l.qty)}×{fmt(l.priceCents)}</span>
                          <span className={`text-[10px] px-1.5 rounded ${l.taxable ? 'bg-blue-900/60 text-blue-300' : 'bg-gray-800 text-gray-500'}`}>{l.taxable ? 'tax' : 'no tax'}{l.taxCategory === 'review' ? ' ⚠' : ''}</span>
                          <span className="w-16 text-right">{fmt(amt(l))}</span>
                          <button onClick={() => post({ action: 'remove_line', lineId: l.id })} className="text-gray-600">×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <AddLineForm onAdd={(line) => post({ action: 'add_line', serviceId: s.id, line })} />
                </div>
              ))}
            </div>

            {/* Add service */}
            <div className="flex gap-2 mt-4">
              <input className={`${inputCls} flex-1`} placeholder="Add a service" value={newSvc} onChange={(e) => setNewSvc(e.target.value)} />
              <button onClick={() => { if (newSvc.trim()) { post({ action: 'add_service', title: newSvc.trim() }); setNewSvc('') } }} className="bg-gray-800 border border-gray-700 rounded-lg px-4 text-sm">Add</button>
            </div>

            {/* Tax rate + totals */}
            <div className="mt-6 rounded-2xl bg-gray-900 border border-gray-800 p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-gray-400 text-sm">Tax rate</span>
                <input className={`${inputCls} w-20`} defaultValue={taxPct} inputMode="decimal"
                  onBlur={(e) => post({ action: 'set_tax', bps: Math.round((parseFloat(e.target.value) || 0) * 100) })} />
                <span className="text-gray-500 text-sm">%</span>
                {est.needsTaxReview && <span className="ml-auto text-amber-400 text-xs">⚠ Some lines need tax review</span>}
              </div>
              <div className="space-y-1 text-sm">
                <Row label="Taxable subtotal" value={fmt(est.taxableSubtotalCents)} />
                <Row label="Non-taxable subtotal" value={fmt(est.nontaxableSubtotalCents)} />
                <Row label={`Tax (${taxPct}%)`} value={fmt(est.taxCents)} />
                <div className="border-t border-gray-800 mt-1 pt-1"><Row label="Grand total" value={fmt(est.totalCents)} bold /></div>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return <div className="flex justify-between"><span className={bold ? 'text-white font-semibold' : 'text-gray-400'}>{label}</span><span className={bold ? 'text-white font-bold' : 'text-gray-200'}>{value}</span></div>
}
