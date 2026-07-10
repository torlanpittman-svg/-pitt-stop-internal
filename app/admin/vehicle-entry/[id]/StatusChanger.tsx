'use client'

import { useState } from 'react'

const STATUSES = [
  { value: 'ready_for_quickbooks', label: 'Ready for QuickBooks' },
  { value: 'pending_quickbooks',   label: 'Pending QuickBooks' },
  { value: 'quickbooks_updated',   label: 'QuickBooks Updated' },
  { value: 'quickbooks_error',     label: 'QuickBooks Error' },
  { value: 'needs_review',         label: 'Needs Review' },
]

export default function StatusChanger({
  entryId,
  currentStatus,
}: {
  entryId: string
  currentStatus: string
}) {
  const [status, setStatus] = useState(currentStatus)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)

  const handleChange = async (newStatus: string) => {
    setStatus(newStatus)
    setSaving(true)
    setSaved(false)
    await fetch(`/api/vehicle-entry/entries/${entryId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: newStatus }),
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div className="flex items-center gap-3">
      <select
        value={status}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className="bg-gray-700 border border-gray-600 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
      >
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
      {saving && <span className="text-gray-400 text-sm">Saving…</span>}
      {saved  && <span className="text-green-400 text-sm">✓ Saved</span>}
    </div>
  )
}
