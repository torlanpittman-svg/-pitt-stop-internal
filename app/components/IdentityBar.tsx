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
  completionInvoiceEnabled: boolean
}

const EMPTY: IdentityState = { enabled: false, actor: null, elevated: false, elevatedUntil: null, effectiveRole: 'employee', minutes: 10, completionEnabled: false, estimateEnabled: false, completionInvoiceEnabled: false }

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
  // prefetch={false}: /admin is Basic-Auth gated. A background prefetch would hit a
  // 401 and make mobile browsers pop the native sign-in dialog on normal pages.
  // The link still works on click (a real navigation shows the admin login).
  return <Link href="/admin" prefetch={false} className={className}>Admin</Link>
}

const ROLE_LABEL: Record<Role, string> = { employee: '', manager: 'Manager', admin: 'Admin' }

/**
 * Signed-in identity strip. Identity + role come from the PIN at sign-in (the signed session), so
 * there is no client-side "switch user" — just who is signed in + Sign out. Sign out clears the
 * signed session and returns to the PIN screen so the next person signs in as themselves.
 */
export default function IdentityBar() {
  const id = useIdentity()
  const [busy, setBusy] = useState(false)

  if (!id.actor) return null   // anonymous/legacy session or not signed in → nothing to show

  const signOut = async () => {
    setBusy(true)
    try { await fetch('/api/auto-sales/session', { method: 'DELETE' }) } catch { /* ignore */ }
    window.location.href = '/auto-sales/login'
  }

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">👤</span>
        <span className="text-gray-400">Signed in as</span>
        <span className="text-gray-200 font-medium">{id.actor.name}</span>
        {ROLE_LABEL[id.actor.role] && <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded-full px-1.5 py-0.5">{ROLE_LABEL[id.actor.role]}</span>}
        <button onClick={signOut} disabled={busy} className="ml-auto text-xs text-gray-400 underline disabled:opacity-40">{busy ? 'Signing out…' : 'Sign out'}</button>
      </div>
    </div>
  )
}
