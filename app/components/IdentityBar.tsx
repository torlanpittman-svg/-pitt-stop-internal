'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

export type Role = 'employee' | 'manager' | 'admin'
export interface IdentityState {
  enabled: boolean
  actor: { id: string; name: string; role: Role } | null
  elevated: boolean
  elevatedUntil: number | null
  effectiveRole: Role
  minutes: number
  completionEnabled: boolean
  estimateEnabled: boolean
}

const EMPTY: IdentityState = { enabled: false, actor: null, elevated: false, elevatedUntil: null, effectiveRole: 'employee', minutes: 10, completionEnabled: false, estimateEnabled: false }

/** Fetches identity state once (+ on refresh); auto-refreshes when elevation expires. */
export function useIdentity() {
  const [state, setState] = useState<IdentityState>(EMPTY)
  const refresh = useCallback(async () => {
    try { const r = await fetch('/api/identity', { cache: 'no-store' }); setState(await r.json()) } catch { /* keep prior */ }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  // Keep every useIdentity() instance (IdentityBar, AdminLink, future manager UI) in
  // sync: any identity change broadcasts 'ps-identity' and all instances re-fetch.
  useEffect(() => {
    const h = () => void refresh()
    window.addEventListener('ps-identity', h)
    return () => window.removeEventListener('ps-identity', h)
  }, [refresh])
  // When elevated, schedule a refresh right at expiry so manager sections auto-hide.
  useEffect(() => {
    if (!state.elevated || !state.elevatedUntil) return
    const ms = Math.max(0, state.elevatedUntil - Date.now()) + 500
    const t = setTimeout(() => void refresh(), ms)
    return () => clearTimeout(t)
  }, [state.elevated, state.elevatedUntil, refresh])
  return { ...state, refresh }
}

/** Admin link — hidden from base employees when identity is on; always shown when
 *  identity is disabled (today's behavior). The /admin area itself stays behind the
 *  ADMIN_PASSWORD regardless. */
export function AdminLink({ className = '' }: { className?: string }) {
  const id = useIdentity()
  if (id.enabled && id.effectiveRole !== 'admin') return null
  return <Link href="/admin" className={className}>Admin</Link>
}

const ROLE_LABEL: Record<Role, string> = { employee: '', manager: 'Manager', admin: 'Admin' }

export default function IdentityBar() {
  const id = useIdentity()
  const [panel, setPanel] = useState(false)  // switch-user sheet
  const [employees, setEmployees] = useState<{ id: string; name: string; role: Role }[]>([])

  useEffect(() => {
    if (panel) fetch('/api/workflow/employees').then((r) => r.json()).then((d) => setEmployees(d.employees ?? []))
  }, [panel])

  if (!id.enabled) return null

  const sync = () => window.dispatchEvent(new Event('ps-identity'))
  // Selecting a person is remembered on the device across closes/reloads (base role
  // is active automatically — no PIN for normal work).
  const select = async (employeeId: string) => {
    await fetch('/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'select', employeeId }) })
    setPanel(false); sync()
  }
  // Lock = sign this person out of the device so the next person must re-select.
  const lock = async () => { await fetch('/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'signout' }) }); sync() }

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">👤</span>
        {id.actor ? (
          <>
            <button onClick={() => setPanel(true)} className="text-gray-200 font-medium">{id.actor.name}</button>
            {ROLE_LABEL[id.actor.role] && <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded-full px-1.5 py-0.5">{ROLE_LABEL[id.actor.role]}</span>}
            <span className="ml-auto flex items-center gap-3">
              <button onClick={() => setPanel(true)} className="text-xs text-gray-400 underline">Switch</button>
              <button onClick={lock} className="text-xs text-gray-400 underline">Lock</button>
            </span>
          </>
        ) : (
          <button onClick={() => setPanel(true)} className="text-blue-400 font-semibold">Who are you?</button>
        )}
      </div>

      {panel && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={() => setPanel(false)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4"><h2 className="text-white font-bold text-xl">Who are you?</h2><button onClick={() => setPanel(false)} className="text-gray-500 text-sm">Close</button></div>
            <div className="grid grid-cols-2 gap-3">
              {employees.map((e) => (
                <button key={e.id} onClick={() => select(e.id)} className="bg-gray-800 border border-gray-700 text-white font-semibold py-4 rounded-2xl active:bg-gray-700">
                  {e.name}{e.role !== 'employee' ? <span className="block text-[10px] text-gray-400 uppercase">{e.role}</span> : null}
                </button>
              ))}
              {employees.length === 0 && <p className="text-gray-500 text-sm col-span-2 text-center py-6">No employees yet — add them in Admin.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
