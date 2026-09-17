'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { InvoiceDraft } from '@/apps/workflow/invoice-draft'
interface Summary { draft: InvoiceDraft; revision: string; email: string; phone: string; qbNumber: string | null; sentAt: string | null }
const money = (c: number) => `$${(c / 100).toFixed(2)}`
export default function EstimateActions({ id, editorBusy, onBusyChange }: { id: string; editorBusy: boolean; onBusyChange: (busy: boolean) => void }) {
  const router = useRouter()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState<'send' | 'convert' | null>(null)
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [contactOpen, setContactOpen] = useState(false)
  useEffect(() => {
    let active = true
    fetch(`/api/estimates/${id}`).then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); return data })
      .then(data => { if (active) { setSummary(data); setEmail(data.email); setPhone(data.phone) } })
      .catch(e => { if (active) setError(e.message || 'Unable to load total.') })
    return () => { active = false }
  }, [id])
  const action = async (kind: 'contact' | 'send' | 'convert') => {
    if (busy || editorBusy || !summary) return
    setBusy(true); onBusyChange(true); setError(''); setMessage('')
    try {
      const response = await fetch(`/api/estimates/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: kind, revision: summary.revision, email, phone }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to complete action.')
      if (data.converted) { router.push(`/orders/${id}`); return }
      setSummary(data); setEmail(data.email); setPhone(data.phone); setContactOpen(false)
      setMessage(kind === 'send' ? 'QuickBooks confirmed the estimate was sent.' : 'Contact details saved.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to complete action.') }
    finally { setBusy(false); onBusyChange(false); setConfirm(null) }
  }
  return <section className="mt-6 rounded-2xl border border-gray-800 p-4 space-y-3">
    <h2 className="text-lg font-bold">Customer estimate</h2>
    {summary ? <>
      <div className="space-y-2 text-sm text-gray-400">
        <div className="flex justify-between"><span>Work</span><span>{money(summary.draft.workPriceCents)}</span></div>
        <div className="flex justify-between"><span>Shop supplies</span><span>{money(summary.draft.shopSupplies.cents)}</span></div>
        <div className="flex justify-between"><span>{summary.draft.paymentCharge.label}</span><span>{money(summary.draft.paymentCharge.cents)}</span></div>
        <div className="flex justify-between"><span>Tax</span><span>{money(summary.draft.tax.cents)}</span></div>
        <div className="flex justify-between border-t border-gray-700 pt-3 text-white text-xl font-bold"><span>Estimate total</span><span>{money(summary.draft.totalCents)}</span></div>
      </div>
      <p className="text-gray-400 text-sm">Send to: {summary.email || 'No email added'} <button disabled={busy || editorBusy} onClick={() => setContactOpen(!contactOpen)} className="text-blue-400 ml-2">Edit contact</button></p>
      {contactOpen && <form className="space-y-3" onSubmit={e => { e.preventDefault(); void action('contact') }}>
        <label className="block text-sm">Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} className="block w-full rounded-lg bg-gray-900 border border-gray-700 p-3" /></label>
        <label className="block text-sm">Phone<input type="tel" value={phone} onChange={e => setPhone(e.target.value)} className="block w-full rounded-lg bg-gray-900 border border-gray-700 p-3" /></label>
        <button disabled={busy || editorBusy} className="rounded-lg bg-gray-800 px-4 py-2">Save contact</button>
      </form>}
      {summary.qbNumber && <p className="text-gray-500 text-xs">QuickBooks estimate #{summary.qbNumber}{summary.sentAt ? ` · Last sent ${new Date(summary.sentAt).toLocaleString()}` : ''}</p>}
      <p className="text-gray-500 text-xs">This estimate stays off the Work Board until you move it. Moving it confirms the customer approved all listed services.</p>
      <button disabled={busy || editorBusy || !summary.draft.priced || !summary.email || contactOpen} onClick={() => setConfirm('send')} className="w-full bg-blue-600 rounded-xl py-3 font-semibold disabled:opacity-40">{busy ? 'Working…' : summary.qbNumber ? 'Send current estimate through QuickBooks' : 'Send estimate through QuickBooks'}</button>
      <button disabled={busy || editorBusy || !summary.draft.priced || contactOpen} onClick={() => setConfirm('convert')} className="w-full border border-gray-600 rounded-xl py-3 font-semibold disabled:opacity-40">Move to Work Board</button>
      {confirm && <div role="alertdialog" aria-label={confirm === 'send' ? 'Confirm estimate email' : 'Confirm approved work'} className="rounded-xl bg-gray-900 border border-blue-700 p-4 space-y-3">
        <p>{confirm === 'send' ? `Send this ${money(summary.draft.totalCents)} estimate to ${summary.email} through QuickBooks? Any existing QuickBooks estimate will be updated to these prices.` : 'Customer approved this estimate and is ready to have the work done? The vehicle will enter the Work Board as Arrived.'}</p>
        <button disabled={busy || editorBusy} onClick={() => action(confirm)} className="bg-blue-600 rounded-lg px-4 py-2 mr-3 disabled:opacity-40">{confirm === 'send' ? 'Send estimate' : 'Approved — move to board'}</button>
        <button disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
      </div>}
    </> : <p className="text-gray-400">Loading estimate total…</p>}
    {error && <p role="alert" className="text-red-400 text-sm">{error} <button onClick={() => window.location.reload()} className="underline">Refresh</button></p>}
    {message && <p role="status" className="text-green-400 text-sm">{message}</p>}
  </section>
}
