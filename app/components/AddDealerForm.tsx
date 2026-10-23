'use client'

/**
 * Manager "+ Add New Dealer". Pick the dealer's EXISTING QuickBooks customer (live,
 * read-only search), optionally give it a stock prefix, save. Writes one row to the
 * existing dealerships table via POST /api/vehicle-entry/dealerships — never QuickBooks.
 */
import { useState, useCallback } from 'react'

interface QbCustomer { id: string; displayName: string; email: string | null }
export interface AddedDealer { id: string; name: string; stockPrefix: string | null; qbCustomerId: string; created: boolean }

export default function AddDealerForm({ onAdded, onCancel }: { onAdded: (d: AddedDealer) => void; onCancel: () => void }) {
  const [query,    setQuery]    = useState('')
  const [results,  setResults]  = useState<QbCustomer[] | null>(null)
  const [picked,   setPicked]   = useState<QbCustomer | null>(null)
  const [prefix,   setPrefix]   = useState('')
  const [email,    setEmail]    = useState('')
  const [busy,     setBusy]     = useState<'search' | 'save' | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  const search = useCallback(async () => {
    if (query.trim().length < 2) return
    setBusy('search'); setError(null); setPicked(null)
    try {
      const res  = await fetch(`/api/vehicle-entry/dealerships/qb-customers?q=${encodeURIComponent(query.trim())}`)
      const data = await res.json() as { customers?: QbCustomer[]; error?: string }
      if (!res.ok) { setError(data.error ?? 'Search failed'); return }
      setResults(data.customers ?? [])
    } catch {
      setError('Network error')
    } finally {
      setBusy(null)
    }
  }, [query])

  const save = useCallback(async () => {
    if (!picked) return
    setBusy('save'); setError(null)
    try {
      const res  = await fetch('/api/vehicle-entry/dealerships', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ qbCustomerId: picked.id, stockPrefix: prefix.trim() || null, billingEmail: email.trim() || null }),
      })
      const data = await res.json() as AddedDealer & { error?: string }
      if (!res.ok) { setError(data.error ?? 'Could not add dealer'); return }
      onAdded(data)
    } catch {
      setError('Network error')
    } finally {
      setBusy(null)
    }
  }, [picked, prefix, email, onAdded])

  const input = 'w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="rounded-2xl bg-gray-900 border border-gray-700 p-4 space-y-3">
      <p className="text-white font-semibold">Add New Dealer</p>
      <p className="text-gray-500 text-xs">The dealer must already be a customer in QuickBooks. Nothing is changed in QuickBooks.</p>

      {error && <div className="bg-red-950 border border-red-800 rounded-lg px-3 py-2 text-red-300 text-sm">{error}</div>}

      {!picked ? (
        <>
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search() } }}
              placeholder="Search QuickBooks customers"
              aria-label="Search QuickBooks customers"
              className={input}
            />
            <button
              type="button"
              onClick={() => void search()}
              disabled={busy !== null || query.trim().length < 2}
              className="shrink-0 min-h-11 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-40"
            >
              {busy === 'search' ? '…' : 'Search'}
            </button>
          </div>
          {results && results.length === 0 && <p className="text-gray-500 text-sm">No active QuickBooks customer matches.</p>}
          {results && results.length > 0 && (
            <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800 overflow-hidden">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => { setPicked(c); setEmail(c.email ?? '') }}
                    className="w-full text-left px-3 py-3 min-h-11 hover:bg-gray-800"
                  >
                    <span className="text-white">{c.displayName}</span>
                    <span className="block text-gray-500 text-xs">QuickBooks #{c.id}{c.email ? ` · ${c.email}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-white">{picked.displayName}</p>
              <p className="text-gray-500 text-xs">QuickBooks #{picked.id}</p>
            </div>
            <button type="button" onClick={() => setPicked(null)} className="text-gray-400 hover:text-white text-sm min-h-11 px-2">Change</button>
          </div>
          <label className="block">
            <span className="text-gray-400 text-xs">Stock prefix (optional)</span>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="Leave blank if stock # is the VIN"
              className={`${input} font-mono`}
            />
            <span className="block text-gray-600 text-xs mt-1">
              Blank = no prefix: staff pick this dealer from the list, and it is never auto-detected.
            </span>
          </label>
          <label className="block">
            <span className="text-gray-400 text-xs">Billing email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" className={input} />
          </label>
        </>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!picked || busy !== null}
          className="flex-1 min-h-11 rounded-lg bg-white text-black font-semibold disabled:opacity-40"
        >
          {busy === 'save' ? 'Saving…' : 'Add Dealer'}
        </button>
        <button type="button" onClick={onCancel} className="min-h-11 px-4 rounded-lg border border-gray-700 text-gray-300">
          Cancel
        </button>
      </div>
    </div>
  )
}
