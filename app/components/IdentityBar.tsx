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

/**
 * Admin entry point — ALWAYS visible so the owner/admin can reach the ADMIN_PASSWORD login from any
 * operational session. Visibility is NOT authorization: /admin/* is enforced server-side (proxy.ts +
 * ADMIN_PASSWORD). A manager/employee session grants NO admin access — clicking simply routes to the
 * admin area, which independently prompts for the admin password. (Previously this link was hidden
 * unless effectiveRole==='admin'; once client-side elevation was retired nothing could reach that
 * role, so the only route to the admin login disappeared for the owner. We do not hide the auth route.)
 *
 * prefetch={false}: /admin is Basic-Auth gated; a background prefetch would 401 and pop the native
 * sign-in dialog on normal pages. The link still works on click (a real navigation shows the login).
 */
export function AdminLink({ className = '' }: { className?: string }) {
  return <Link href="/admin" prefetch={false} className={className}>Admin</Link>
}

const ROLE_LABEL: Record<Role, string> = { employee: '', manager: 'Manager', admin: 'Admin' }

/**
 * Signed-in identity strip. A named signed session shows "Signed in as {name}" + Sign out (= switch
 * user). An anonymous/legacy session (old shared EMPLOYEE_PIN, before individual PINs) — or a
 * not-yet-identified device — shows an "Identify / Switch user" prompt so nobody is trapped in an
 * unnamed session: it routes to the PIN screen where an individual PIN establishes a signed identity.
 * Identity + role come from the PIN at sign-in; there is no client-side identity selection.
 */
export default function IdentityBar() {
  const id = useIdentity()
  const [busy, setBusy] = useState(false)

  if (!id.enabled) return null   // identity system off (legacy) → nothing to show

  const signOut = async () => {
    setBusy(true)
    try { await fetch('/api/auto-sales/session', { method: 'DELETE' }) } catch { /* ignore */ }
    window.location.href = '/auto-sales/login'
  }

  // Anonymous / legacy shared session (or signed out): offer identification. Operational access may
  // still be valid for cutover safety, but the user can always move to their individual identity.
  if (!id.actor) {
    return (
      <div className="w-full">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">👤</span>
          <span className="text-gray-400">Not identified — shared session</span>
          <a href="/auto-sales/login" className="ml-auto text-xs text-gray-200 underline">Identify / Switch user</a>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">👤</span>
        <span className="text-gray-400">Signed in as</span>
        <span className="text-gray-200 font-medium">{id.actor.name}</span>
        {ROLE_LABEL[id.actor.role] && <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded-full px-1.5 py-0.5">{ROLE_LABEL[id.actor.role]}</span>}
        <button onClick={signOut} disabled={busy} className="ml-auto text-xs text-gray-400 underline disabled:opacity-40">{busy ? 'Signing out…' : 'Sign out / Switch user'}</button>
      </div>
    </div>
  )
}
