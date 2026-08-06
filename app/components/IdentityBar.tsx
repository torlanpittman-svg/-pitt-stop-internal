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
}

const EMPTY: IdentityState = { enabled: false, actor: null, elevated: false, elevatedUntil: null, effectiveRole: 'employee', minutes: 10 }

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

export default function IdentityBar() {
  const id = useIdentity()
  const [panel, setPanel] = useState<null | 'switch' | 'pin'>(null)
  const [employees, setEmployees] = useState<{ id: string; name: string; role: Role }[]>([])
  const [pin, setPin] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [left, setLeft] = useState('')

  useEffect(() => {
    if (panel === 'switch') fetch('/api/workflow/employees').then((r) => r.json()).then((d) => setEmployees(d.employees ?? []))
  }, [panel])

  // Live countdown while elevated
  useEffect(() => {
    if (!id.elevated || !id.elevatedUntil) { setLeft(''); return }
    const tick = () => {
      const s = Math.max(0, Math.floor((id.elevatedUntil! - Date.now()) / 1000))
      setLeft(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)
    }
    tick(); const t = setInterval(tick, 1000); return () => clearInterval(t)
  }, [id.elevated, id.elevatedUntil])

  if (!id.enabled) return null

  const sync = () => window.dispatchEvent(new Event('ps-identity'))
  const select = async (employeeId: string) => {
    await fetch('/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'select', employeeId }) })
    setPanel(null); setMsg(null); sync()
  }
  const elevate = async () => {
    setMsg(null)
    const r = await fetch('/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'elevate', pin }) })
    const d = await r.json()
    if (!d.ok) { setMsg(d.error ?? 'Could not unlock'); return }
    setPin(''); setPanel(null); sync()
  }
  const lock = async () => { await fetch('/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'lock' }) }); sync() }

  const canElevate = id.actor && (id.actor.role === 'manager' || id.actor.role === 'admin')

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">👤</span>
        {id.actor ? (
          <button onClick={() => setPanel('switch')} className="text-gray-200 font-medium">{id.actor.name}</button>
        ) : (
          <button onClick={() => setPanel('switch')} className="text-blue-400 font-semibold">Who are you?</button>
        )}
        {id.elevated ? (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-xs font-semibold text-amber-300 bg-amber-950/50 border border-amber-700/50 rounded-full px-2 py-0.5">Manager mode · {left}</span>
            <button onClick={lock} className="text-xs text-gray-300 underline">Lock</button>
          </span>
        ) : canElevate ? (
          <button onClick={() => { setPanel('pin'); setMsg(null) }} className="ml-auto text-xs text-gray-400 underline">Manager tools 🔒</button>
        ) : null}
      </div>

      {panel === 'switch' && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={() => setPanel(null)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4"><h2 className="text-white font-bold text-xl">Who are you?</h2><button onClick={() => setPanel(null)} className="text-gray-500 text-sm">Close</button></div>
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

      {panel === 'pin' && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={() => setPanel(null)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4"><h2 className="text-white font-bold text-xl">Manager PIN</h2><button onClick={() => setPanel(null)} className="text-gray-500 text-sm">Cancel</button></div>
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" autoFocus
              placeholder="4-digit PIN" className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-2xl tracking-[0.5em] text-center" />
            {msg && <p className="text-red-400 text-sm mt-2">{msg}</p>}
            <button onClick={elevate} disabled={pin.length < 4} className="mt-4 w-full h-14 rounded-2xl bg-blue-600 text-white text-lg font-bold disabled:opacity-40">Unlock manager tools</button>
            <p className="text-gray-600 text-xs text-center mt-2">Unlocks for {id.minutes} minutes, then re-locks automatically.</p>
          </div>
        </div>
      )}
    </div>
  )
}
