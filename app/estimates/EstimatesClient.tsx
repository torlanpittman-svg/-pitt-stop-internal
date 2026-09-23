'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface Row { id: string; customer: string; vehicle: string; total: number; status: string; date: string; qbNumber: string | null }
const field = 'w-full rounded-xl bg-gray-900 border border-gray-700 p-3 text-white'
export default function EstimatesClient({ rows }: { rows: Row[] }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [history, setHistory] = useState(false)
  const visible = rows.filter(r => (history || (r.status !== 'On Work Board' && r.status !== 'Archived')) && `${r.customer} ${r.vehicle} ${r.qbNumber ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="max-w-3xl mx-auto p-4 sm:p-6">
    <div className="flex items-center justify-between gap-4 mb-2"><h1 className="text-3xl font-bold">Estimates</h1>
      <button onClick={() => router.push('/estimates/new')} className="rounded-xl bg-blue-600 px-4 py-3 font-semibold">New estimate</button></div>
    <p className="text-gray-400 mb-6">Quote now. Move approved work to the board when the customer comes back.</p>
    <input aria-label="Search estimates" placeholder="Search customer, vehicle, or estimate number" value={query} onChange={e => setQuery(e.target.value)} className={field} />
    <label className="flex gap-2 items-center my-4 text-sm text-gray-400"><input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} />Include converted and archived estimates</label>
    <div className="space-y-3">{visible.map(r => <Link key={r.id} href={r.status === 'On Work Board' ? `/orders/${r.id}` : `/orders/${r.id}/estimate`} className="block rounded-2xl border border-gray-800 bg-gray-900 p-4 hover:border-gray-600">
      <div className="flex justify-between gap-3"><h2 className="font-semibold">{r.customer}</h2><span className="text-blue-300 text-sm">{r.status}</span></div>
      <p className="text-gray-400">{r.vehicle}</p>
      <div className="flex justify-between mt-3 text-sm"><span className="text-gray-500">{new Date(r.date).toLocaleDateString()}{r.qbNumber && ` · QB #${r.qbNumber}`}</span><span>{r.total > 0 ? `$${(r.total / 100).toFixed(2)}` : 'Not priced'}</span></div>
    </Link>)}</div>
    {!visible.length && <div className="text-center py-12 text-gray-400">{query ? 'No matching estimates.' : 'No estimates yet. Start with a customer and vehicle.'}</div>}
  </div>
}
