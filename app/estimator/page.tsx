'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import NavHeader from '@/app/components/NavHeader'

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
            <label className="text-gray-400 text-xs uppercase tracking-wide">
              Customer Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="First and last name"
              autoComplete="name"
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
            />
          </div>

          {/* Phone */}
          <div className="space-y-1.5">
            <label className="text-gray-400 text-xs uppercase tracking-wide">
              Phone Number <span className="text-gray-600 text-xs normal-case">(optional)</span>
            </label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="(555) 123-4567"
              autoComplete="tel"
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
            />
          </div>

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
