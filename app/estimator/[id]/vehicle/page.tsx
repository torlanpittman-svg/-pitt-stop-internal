'use client'

import { useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { YEARS, MAKES, COLORS, getModelsForMake } from '@/apps/vehicle-entry/vehicle-data'

const VEHICLE_SIZES = [
  'Compact Car',
  'Mid-size Sedan',
  'Full-size Sedan',
  'Coupe',
  'Compact SUV / Crossover',
  'Mid-size SUV',
  'Full-size SUV (2-row)',
  'Full-size SUV (3-row)',
  'Minivan',
  'Compact Pickup',
  'Full-size Pickup (Crew Cab)',
  'Full-size Pickup (Regular Cab)',
  'Sports Car',
  'Luxury Sedan',
  'Full-size Luxury SUV',
  'Cargo Van',
  'Exotic',
]

function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
  required,
}: {
  label: string
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  placeholder?: string
  required?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-gray-400 text-xs uppercase tracking-wide">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3.5 text-base appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">{placeholder ?? `Select ${label}`}</option>
        {options.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  )
}

export default function VehicleInfoPage() {
  const router = useRouter()
  const { id } = useParams<{ id: string }>()

  const [fields, setFields] = useState({
    vehicleYear:  '',
    vehicleMake:  '',
    vehicleModel: '',
    vehicleColor: '',
    vehicleSize:  '',
  })
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const handleMakeChange = useCallback((make: string) => {
    setFields(f => ({ ...f, vehicleMake: make, vehicleModel: '' }))
  }, [])

  const canContinue = fields.vehicleYear && fields.vehicleMake && fields.vehicleModel && fields.vehicleColor

  const handleSubmit = useCallback(async () => {
    if (!canContinue) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/estimator/estimates/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed to save vehicle info')
      router.push(`/estimator/${id}/photos`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }, [id, fields, canContinue, router])

  const models = getModelsForMake(fields.vehicleMake)

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-6 pb-2 shrink-0">
        <Link
          href="/estimator"
          className="text-gray-500 text-sm hover:text-gray-300 transition-colors"
        >
          ← Back
        </Link>
        <span className="text-white font-semibold">Vehicle Information</span>
        <div className="w-14" />
      </div>

      {/* Step indicator */}
      <div className="px-5 pt-2 pb-4 shrink-0">
        <div className="flex items-center gap-2">
          {[1,2,3,4,5,6,7].map(n => (
            <div
              key={n}
              className={`h-1 flex-1 rounded-full ${n <= 2 ? 'bg-blue-500' : 'bg-gray-800'}`}
            />
          ))}
        </div>
        <p className="text-gray-500 text-xs mt-2">Step 2 of 7 — Vehicle Information</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-32">
        <div className="space-y-4 pt-2">
          <Select
            label="Year"
            value={fields.vehicleYear}
            options={YEARS}
            onChange={v => setFields(f => ({ ...f, vehicleYear: v }))}
            required
          />
          <Select
            label="Make"
            value={fields.vehicleMake}
            options={MAKES}
            onChange={handleMakeChange}
            required
          />
          <Select
            label="Model"
            value={fields.vehicleModel}
            options={models}
            onChange={v => setFields(f => ({ ...f, vehicleModel: v }))}
            placeholder={fields.vehicleMake ? 'Select Model' : 'Select Make first'}
            required
          />
          <Select
            label="Color"
            value={fields.vehicleColor}
            options={COLORS as unknown as string[]}
            onChange={v => setFields(f => ({ ...f, vehicleColor: v }))}
            required
          />
          <Select
            label="Vehicle Size / Type"
            value={fields.vehicleSize}
            options={VEHICLE_SIZES}
            onChange={v => setFields(f => ({ ...f, vehicleSize: v }))}
            placeholder="Select size (optional)"
          />

          {error && (
            <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
              {error}
            </div>
          )}
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur px-5 py-4 border-t border-gray-800">
        <button
          onClick={handleSubmit}
          disabled={!canContinue || loading}
          className="w-full py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-lg transition-colors"
        >
          {loading ? 'Saving…' : 'Continue to Photos →'}
        </button>
      </div>
    </main>
  )
}
