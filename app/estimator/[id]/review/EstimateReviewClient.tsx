'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

export default function EstimateReviewClient({
  estimateId,
  recommendedPriceCents,
  totalCents,
}: {
  estimateId:            string
  recommendedPriceCents: number | null | undefined
  totalCents:            number
}) {
  const router = useRouter()

  const [showAdjust, setShowAdjust]   = useState(false)
  const [adjustedPrice, setAdjusted]  = useState<string>(
    String(Math.round((recommendedPriceCents ?? totalCents) / 100))
  )
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  async function approve(overrideCents?: number) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/estimator/estimates/${estimateId}/approve`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvedPriceCents: overrideCents ?? recommendedPriceCents ?? totalCents,
        }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to approve estimate')
      router.push(`/estimator/${estimateId}/saved`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const parsedDollars = parseFloat(adjustedPrice) || 0
  const parsedCents   = Math.round(parsedDollars * 100)

  return (
    <>
      {/* Price adjust sheet */}
      {showAdjust && (
        <div className="fixed inset-0 z-20 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowAdjust(false)} />
          <div className="relative bg-gray-900 border-t border-gray-700 rounded-t-3xl px-6 pt-6 pb-10 z-30">
            <p className="text-white font-bold text-lg mb-1">Adjust Price</p>
            <p className="text-gray-500 text-sm mb-4">
              Recommended: {formatCents(recommendedPriceCents ?? totalCents)}
            </p>
            <div className="relative mb-4">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white text-lg font-bold">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={adjustedPrice}
                onChange={e => setAdjusted(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl pl-8 pr-4 py-3.5 text-xl font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setShowAdjust(false)}
                className="py-3.5 rounded-xl border border-gray-600 text-gray-300 font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowAdjust(false); approve(parsedCents) }}
                disabled={parsedDollars <= 0 || saving}
                className="py-3.5 rounded-xl bg-blue-600 text-white font-bold disabled:opacity-40"
              >
                Approve at {formatCents(parsedCents)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fixed footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur px-5 py-4 border-t border-gray-800">
        {error && (
          <p className="text-red-400 text-sm text-center mb-2">{error}</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setShowAdjust(true)}
            disabled={saving}
            className="py-4 rounded-xl border border-gray-600 text-gray-200 font-semibold hover:border-gray-400 active:bg-gray-800 transition-colors disabled:opacity-40"
          >
            Adjust Price
          </button>
          <button
            onClick={() => approve()}
            disabled={saving}
            className="py-4 rounded-xl bg-green-600 hover:bg-green-500 active:bg-green-700 text-white font-bold transition-colors disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Approve ✓'}
          </button>
        </div>
      </div>
    </>
  )
}
