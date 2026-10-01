'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import NavHeader from '@/app/components/NavHeader'

interface CustomerSearchResult {
  id: string
  name: string
  subtitle: string
  phone: string | null
  customerType: string
  matchedVia: 'customer' | 'vehicle'
}

export default function CustomersSearchPage() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<CustomerSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const query = q.trim()
    const t = setTimeout(async () => {
      if (query.length < 2) { setResults([]); setSearched(false); setError(null); return }
      setLoading(true); setError(null)
      try {
        const r = await fetch(`/api/customers/search?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
        const d = await r.json()
        if (!d.ok) { setError(d.error || 'Search failed'); setResults([]); setSearched(true); return }
        setResults(d.results || []); setSearched(true)
      } catch { setError('Search failed'); setResults([]); setSearched(true) }
      finally { setLoading(false) }
    }, query.length < 2 ? 0 : 250)
    return () => clearTimeout(t)
  }, [q])

  const hint = useMemo(() => q.trim().length > 0 && q.trim().length < 2, [q])

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <NavHeader back={{ href: '/', label: 'Home' }} title="Customers" />
      <div className="mx-auto w-full max-w-2xl px-4 pt-5">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          inputMode="search"
          placeholder="Search name, phone, email, plate, or VIN"
          className="w-full rounded-xl bg-gray-900 border border-gray-800 px-4 py-3 text-base outline-none focus:border-gray-600"
        />
        {hint && <p className="mt-2 text-xs text-gray-600">Type at least 2 characters.</p>}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        {loading && <p className="mt-3 text-sm text-gray-500">Searching…</p>}

        {searched && !loading && results.length === 0 && !error && (
          <p className="mt-5 text-sm text-gray-500">No customers match “{q.trim()}”. Searching finds people in the directory by name, phone, email, plate, or VIN; a new walk-in is added through Quick Entry.</p>
        )}

        <ul className="mt-4 space-y-2">
          {results.map((r) => (
            <li key={r.id}>
              <Link href={`/customers/${r.id}`} className="block rounded-2xl bg-gray-900 border border-gray-800 px-4 py-3 active:bg-gray-800">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold leading-tight truncate">{r.name}</p>
                    {r.subtitle && <p className="text-xs text-gray-500 mt-0.5 truncate">{r.subtitle}</p>}
                    {r.matchedVia === 'vehicle' && <p className="text-[11px] text-sky-400 mt-0.5">matched by vehicle plate/VIN</p>}
                  </div>
                  <span className="flex-none text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-gray-800 text-gray-400 border border-gray-700">{r.customerType}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
