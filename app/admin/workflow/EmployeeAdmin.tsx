'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import type { EmployeeRow } from '@/apps/workflow/db'

export default function EmployeeAdmin({ initialEmployees }: { initialEmployees: EmployeeRow[] }) {
  const [employees, setEmployees] = useState<EmployeeRow[]>(initialEmployees)
  const [newName,   setNewName]   = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const reload = useCallback(async () => {
    const res = await fetch('/api/workflow/employees')
    const data = await res.json()
    setEmployees(data.employees ?? [])
  }, [])

  const addEmployee = useCallback(async () => {
    if (!newName.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/workflow/employees', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: newName.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to add'); return }
      setNewName('')
      await reload()
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }, [newName, saving, reload])

  const removeEmployee = useCallback(async (id: string) => {
    await fetch('/api/workflow/employees', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'deactivate', id }),
    })
    await reload()
  }, [reload])

  return (
    <main className="min-h-screen bg-gray-950 px-6 pt-12 pb-10">
      <Link href="/admin" className="text-gray-500 text-sm block mb-8">← Admin</Link>

      <h1 className="text-white font-bold text-2xl mb-1">Employees</h1>
      <p className="text-gray-500 text-sm mb-8">Manage who can be assigned to vehicles</p>

      {/* Add form */}
      <div className="flex gap-3 mb-8">
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addEmployee() }}
          placeholder="Employee name"
          className="flex-1 bg-gray-900 border border-gray-700 text-white rounded-xl px-4 py-3 text-base outline-none focus:border-blue-500"
        />
        <button
          onClick={addEmployee}
          disabled={!newName.trim() || saving}
          className="bg-blue-600 text-white font-bold px-5 py-3 rounded-xl active:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          Add
        </button>
      </div>

      {error && (
        <p className="text-red-400 text-sm mb-4">{error}</p>
      )}

      {/* Employee list */}
      <div className="space-y-2">
        {employees.length === 0 && (
          <p className="text-gray-600 text-center py-8">No employees yet</p>
        )}
        {employees.map(emp => (
          <div
            key={emp.id}
            className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-5 py-4"
          >
            <span className="text-white font-medium">{emp.name}</span>
            <button
              onClick={() => removeEmployee(emp.id)}
              className="text-gray-600 text-sm hover:text-red-400 transition-colors"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </main>
  )
}
