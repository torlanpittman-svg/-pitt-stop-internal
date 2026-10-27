'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import NavHeader from '@/app/components/NavHeader'
import { useCustomerLookup } from '@/app/components/useCustomerLookup'
import { type CustomerMatch } from '@/apps/quick-entry/customers'

const SERVICE_OPTIONS = [
  { value: 'full_detail',      label: 'Full Detail',        hint: 'Interior + exterior' },
  { value: 'exterior_only',    label: 'Exterior Only',      hint: 'Wash, polish, wheels' },
  { value: 'interior_only',    label: 'Interior Only',      hint: 'Vacuum, shampoo, surfaces' },
  { value: 'specific_service', label: 'Specific Service',   hint: 'I\'ll describe on the next screen' },
]

export default function EstimatorIntakePage() {
  const router = useRouter()

  const [name,    setName]    = useState('')
  const [phone,   setPhone]   = useState('')
  const [focus,   setFocus]   = useState('full_detail')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  // Returning-customer lookup (shared with Quick Entry). Searches by name OR phone as typed.
  const { matches, status: custStatus, error: custError, capped: custCapped, search: searchCustomers, clear: clearCustomerSearch } = useCustomerLookup()

  // Selecting a suggestion fills BOTH name and phone. A match without a phone clears any stale
  // phone so we never mix one customer's name with another's number; manual edits stay possible.
  const selectCustomer = useCallback((m: CustomerMatch) => {
    setName(m.name || `${m.first} ${m.last}`.trim())
    setPhone(m.phone ?? '')
    clearCustomerSearch()
  }, [clearCustomerSearch])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/estimator/estimates', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName:  name.trim(),
          customerPhone: phone.trim() || null,
          serviceFocus:  focus,
        }),
      })
      const data = await res.json() as { id?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to create estimate')
      router.push(`/estimator/${data.id}/vehicle`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }, [name, phone, focus, router])

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      <NavHeader title="New Estimate" />

      {/* Step indicator */}
      <div className="px-5 pt-2 pb-4 shrink-0">
        <div className="flex items-center gap-2">
          {[1,2,3,4,5,6,7].map(n => (
            <div
              key={n}
              className={`h-1 flex-1 rounded-full ${n === 1 ? 'bg-blue-500' : 'bg-gray-800'}`}
            />
          ))}
        </div>
        <p className="text-gray-500 text-xs mt-2">Step 1 of 7 — Customer Information</p>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 flex flex-col px-5 pb-32 overflow-y-auto">
        <div className="space-y-5 pt-2">

          {/* Name */}
          <div className="space-y-1.5">
            <label htmlFor="customer-name" className="text-gray-400 text-xs uppercase tracking-wide">
              Customer Name <span className="text-red-400">*</span>
            </label>
            <input
              id="customer-name"
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); searchCustomers(e.target.value) }}
              placeholder="First and last name"
              autoComplete="name"
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
            />
          </div>

          {/* Phone */}
          <div className="space-y-1.5">
            <label htmlFor="customer-phone" className="text-gray-400 text-xs uppercase tracking-wide">
              Phone Number <span className="text-gray-600 text-xs normal-case">(optional)</span>
            </label>
            <input
              id="customer-phone"
              type="tel"
              value={phone}
              onChange={e => { setPhone(e.target.value); searchCustomers(e.target.value) }}
              placeholder="(555) 123-4567"
              autoComplete="tel"
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
            />
          </div>

          {/* Returning-customer suggestions — tap to fill name + phone. Manual entry stays available;
              we never auto-select the first result. type="button" so Enter here never submits the form. */}
          {(custStatus !== 'idle' || matches.length > 0) && (
            <div role="region" aria-label="Matching customers" className="rounded-xl border border-gray-700 bg-gray-900 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
                <span className="text-gray-400 text-xs uppercase tracking-wide">Returning customers</span>
                <button type="button" onClick={clearCustomerSearch} className="text-gray-500 text-xs underline underline-offset-2 min-h-11 px-1">Dismiss</button>
              </div>
              <div role="status" aria-live="polite">
                {custStatus === 'loading' && <p className="px-4 py-3 text-gray-500 text-sm">Searching…</p>}
                {custStatus === 'error' && <p className="px-4 py-3 text-amber-300 text-sm">{custError ?? 'Could not search customers.'} You can keep typing manually.</p>}
                {custStatus === 'ready' && matches.length === 0 && <p className="px-4 py-3 text-gray-500 text-sm">No matching customers. Keep typing or enter the details manually.</p>}
              </div>
              {matches.length > 0 && (
                <ul className="divide-y divide-gray-800 max-h-72 overflow-y-auto overscroll-contain">
                  {matches.map((m, i) => (
                    <li key={i}>
                      <button type="button" onClick={() => selectCustomer(m)}
                        className="w-full text-left px-4 py-3 active:bg-gray-800 hover:bg-gray-800/60 focus:outline-none focus:bg-gray-800">
                        <p className="text-white text-sm font-semibold">{m.name || `${m.first} ${m.last}`.trim()}</p>
                        <p className="text-gray-500 text-xs">{[m.phone, m.email].filter(Boolean).join(' · ') || 'no contact'}</p>
                        {m.vehicles.length > 0 && <p className="text-gray-400 text-xs mt-0.5 truncate">{m.vehicles.map((v) => v.label).join(' · ')}</p>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {custStatus === 'ready' && custCapped && matches.length > 0 && (
                <p className="px-4 py-2 text-gray-500 text-xs border-t border-gray-800">Showing the first {matches.length}. Add more of the name or phone to narrow it down.</p>
              )}
            </div>
          )}

          {/* Service Focus */}
          <div className="space-y-2">
            <label className="text-gray-400 text-xs uppercase tracking-wide">
              What are we detailing?
            </label>
            <div className="space-y-2">
              {SERVICE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFocus(opt.value)}
                  className={`w-full flex items-center justify-between rounded-xl px-4 py-3.5 border transition-colors text-left ${
                    focus === opt.value
                      ? 'bg-blue-600/20 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  <span className="font-medium">{opt.label}</span>
                  <span className={`text-sm ${focus === opt.value ? 'text-blue-300' : 'text-gray-500'}`}>
                    {opt.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
              {error}
            </div>
          )}
        </div>
      </form>

      {/* Fixed CTA */}
      <div className="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur px-5 py-4 border-t border-gray-800">
        <button
          onClick={handleSubmit as unknown as React.MouseEventHandler}
          disabled={!name.trim() || loading}
          className="w-full py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg transition-colors"
        >
          {loading ? 'Creating…' : 'Continue →'}
        </button>
      </div>
    </main>
  )
}
