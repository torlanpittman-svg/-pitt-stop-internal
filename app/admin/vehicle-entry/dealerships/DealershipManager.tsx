'use client'

import { useState, useCallback } from 'react'
import type { DealershipRow } from '@/apps/vehicle-entry/db'

export default function DealershipManager({ initial }: { initial: DealershipRow[] }) {
  const [items,     setItems]     = useState<DealershipRow[]>(initial)
  const [editId,    setEditId]    = useState<string | null>(null)
  const [editName,  setEditName]  = useState('')
  const [editPfx,   setEditPfx]   = useState('')
  const [addName,   setAddName]   = useState('')
  const [addPfx,    setAddPfx]    = useState('')
  const [busy,      setBusy]      = useState<string | null>(null)  // id or 'add'
  const [error,     setError]     = useState<string | null>(null)

  const patch = useCallback(async (id: string, data: object) => {
    setBusy(id); setError(null)
    try {
      const res  = await fetch(`/api/vehicle-entry/dealerships/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
      })
      const updated = await res.json() as DealershipRow & { error?: string }
      if (!res.ok) { setError(updated.error ?? 'Update failed'); return }
      setItems(prev => prev.map(d => d.id === id ? updated : d))
      setEditId(null)
    } catch {
      setError('Network error')
    } finally {
      setBusy(null)
    }
  }, [])

  const remove = useCallback(async (id: string) => {
    if (!confirm('Delete this dealership? Existing entries will keep their data.')) return
    setBusy(id); setError(null)
    try {
      await fetch(`/api/vehicle-entry/dealerships/${id}`, { method: 'DELETE' })
      setItems(prev => prev.filter(d => d.id !== id))
    } catch {
      setError('Network error')
    } finally {
      setBusy(null)
    }
  }, [])

  const add = useCallback(async () => {
    if (!addName.trim() || !addPfx.trim()) return
    setBusy('add'); setError(null)
    try {
      const res  = await fetch('/api/vehicle-entry/dealerships', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: addName.trim(), stockPrefix: addPfx.trim() }),
      })
      const data = await res.json() as { id?: string; error?: string }
      if (!res.ok) { setError(data.error ?? 'Add failed'); return }
      setItems(prev => [...prev, {
        id:          data.id!,
        name:        addName.trim(),
        stockPrefix: addPfx.trim().toUpperCase(),
        active:      true,
        createdAt:   new Date(),
      }])
      setAddName(''); setAddPfx('')
    } catch {
      setError('Network error')
    } finally {
      setBusy(null)
    }
  }, [addName, addPfx])

  function startEdit(d: DealershipRow) {
    setEditId(d.id); setEditName(d.name); setEditPfx(d.stockPrefix)
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Existing dealerships */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
        {items.length === 0 ? (
          <div className="px-6 py-10 text-center text-gray-500 text-sm">
            No dealerships yet — add one below.
          </div>
        ) : (
          <div className="divide-y divide-gray-700">
            {items.map(d => (
              <div key={d.id} className="px-5 py-4">
                {editId === d.id ? (
                  // Inline edit
                  <div className="flex items-center gap-3 flex-wrap">
                    <input
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      placeholder="Dealership name"
                      className="flex-1 min-w-0 bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <input
                      value={editPfx}
                      onChange={e => setEditPfx(e.target.value.toUpperCase())}
                      placeholder="Prefix"
                      maxLength={10}
                      className="w-24 bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => patch(d.id, { name: editName, stockPrefix: editPfx })}
                      disabled={busy === d.id}
                      className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-40"
                    >
                      {busy === d.id ? '…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      className="text-gray-500 hover:text-gray-300 text-sm px-2 py-2"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  // Row display
                  <div className="flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium">{d.name}</span>
                        {!d.active && (
                          <span className="text-gray-600 text-xs border border-gray-700 rounded px-1.5 py-0.5">
                            inactive
                          </span>
                        )}
                      </div>
                      <div className="text-gray-400 text-xs font-mono mt-0.5">
                        Prefix: {d.stockPrefix} → stock #{d.stockPrefix}XXXXXX
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => patch(d.id, { active: !d.active })}
                        disabled={busy === d.id}
                        className={`text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-40 ${
                          d.active
                            ? 'border-gray-600 text-gray-400 hover:border-red-700 hover:text-red-400'
                            : 'border-green-700 text-green-400 hover:bg-green-900/30'
                        }`}
                      >
                        {d.active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        onClick={() => startEdit(d)}
                        className="text-xs px-3 py-1.5 rounded-lg border border-gray-600 text-gray-400 hover:border-gray-400 hover:text-white transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => remove(d.id)}
                        disabled={busy === d.id}
                        className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-600 hover:border-red-700 hover:text-red-400 transition-colors disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add new */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Add Dealership
        </h2>
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-0 space-y-1">
            <label className="text-gray-500 text-xs uppercase tracking-wide">Name</label>
            <input
              value={addName}
              onChange={e => setAddName(e.target.value)}
              placeholder="e.g. Riverside Imports"
              onKeyDown={e => e.key === 'Enter' && add()}
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="w-28 space-y-1">
            <label className="text-gray-500 text-xs uppercase tracking-wide">Stock Prefix</label>
            <input
              value={addPfx}
              onChange={e => setAddPfx(e.target.value.toUpperCase())}
              placeholder="e.g. S"
              maxLength={10}
              onKeyDown={e => e.key === 'Enter' && add()}
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={add}
            disabled={!addName.trim() || !addPfx.trim() || busy === 'add'}
            className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-5 py-2.5 rounded-lg text-sm disabled:opacity-40 transition-colors"
          >
            {busy === 'add' ? 'Adding…' : 'Add'}
          </button>
        </div>
        <p className="text-gray-600 text-xs mt-2 px-1">
          Stock numbers are constructed as: [Prefix] + last 6 characters of VIN.
        </p>
      </div>
    </div>
  )
}
