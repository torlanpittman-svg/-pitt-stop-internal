'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import type { OrderWithContext } from '@/apps/workflow/db'
import VehicleCard from './VehicleCard'
import IdentityBar, { useIdentity } from '@/app/components/IdentityBar'
import NavHeader from '@/app/components/NavHeader'

const POLL_INTERVAL = 10_000
const HIGHLIGHT_MS  = 4_000

type FilterTab = 'active' | 'ready'

// Jobs that still require shop work — the DEFAULT board view. A Job leaves this view
// the instant it completes (becomes Ready); it is not deleted and still counts in
// Daily Production. Ready Jobs move to the "Ready" tab (pickup/delivery/reopen).
const ACTIVE_WORK_STATUSES = new Set(['arrived', 'in_progress', 'paused', 'drying', 'qc_ready'])

function filterOrders(orders: OrderWithContext[], tab: FilterTab): OrderWithContext[] {
  if (tab === 'ready') return orders.filter(o => o.status === 'ready')
  return orders.filter(o => ACTIVE_WORK_STATUSES.has(o.status))
}

export default function WorkBoardClient({
  initialOrders,
  newOrderId,
}: {
  initialOrders: OrderWithContext[]
  newOrderId?:   string
}) {
  const identity = useIdentity()
  const [orders,      setOrders]      = useState<OrderWithContext[]>(initialOrders)
  const [tab,         setTab]         = useState<FilterTab>('active')
  const [refreshing,  setRefreshing]  = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(newOrderId ?? null)
  const [showToast,   setShowToast]   = useState(!!newOrderId)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res  = await fetch('/api/workflow/orders', { cache: 'no-store' })
      const data = await res.json() as { orders: OrderWithContext[] }
      setOrders(data.orders ?? [])
    } catch {
      // silent — stale data is better than an error banner
    } finally {
      setRefreshing(false)
    }
  }, [])

  // 10-second polling
  useEffect(() => {
    const id = setInterval(refresh, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [refresh])

  // Clear highlight and toast after HIGHLIGHT_MS
  useEffect(() => {
    if (!highlightId) return
    const t = setTimeout(() => {
      setHighlightId(null)
      setShowToast(false)
    }, HIGHLIGHT_MS)
    return () => clearTimeout(t)
  }, [highlightId])

  const visible = filterOrders(orders, tab)

  const counts = {
    active: orders.filter(o => ACTIVE_WORK_STATUSES.has(o.status)).length,
    ready:  orders.filter(o => o.status === 'ready').length,
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">

      <NavHeader title="Work Board" />

      {/* Success toast */}
      {showToast && (
        <div className="bg-green-900/80 border-b border-green-700/50 px-4 py-3 text-center shrink-0">
          <p className="text-green-300 font-semibold text-sm">Vehicle added to Work Board</p>
        </div>
      )}

      {/* Active employee identity (Phase 1) — hidden when IDENTITY_ENABLED is off */}
      <div className="px-4 pt-4"><IdentityBar /></div>

      {/* Header */}
      <div className="px-4 pt-4 pb-4 flex items-center justify-between">
        <div>
          <h1 className="text-white font-bold text-2xl leading-tight">Work Board</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {counts.active === 0
              ? 'No vehicles need work'
              : `${counts.active} vehicle${counts.active !== 1 ? 's' : ''} need work`}
            {counts.ready > 0 ? ` · ${counts.ready} ready` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {refreshing && (
            <div className="w-4 h-4 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
          )}
          {identity.completionEnabled && (identity.effectiveRole === 'manager' || identity.effectiveRole === 'admin') && (
            <Link href="/production" className="text-gray-300 text-sm font-semibold px-3 py-2.5 rounded-xl border border-gray-700 active:bg-gray-800">
              Production
            </Link>
          )}
          <Link
            href="/quick-entry"
            className="bg-blue-600 text-white font-bold text-sm px-4 py-2.5 rounded-xl active:bg-blue-700 transition-colors"
          >
            + Check In
          </Link>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="px-4 pb-3 flex gap-2 overflow-x-auto scrollbar-none">
        {(
          [
            { key: 'active', label: 'Active', count: counts.active },
            { key: 'ready',  label: 'Ready',  count: counts.ready  },
          ] as { key: FilterTab; label: string; count: number }[]
        ).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-none flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-blue-600 text-white'
                : 'bg-gray-900 text-gray-400 border border-gray-800'
            }`}
          >
            {t.label}
            <span className={`text-xs ${tab === t.key ? 'text-blue-200' : 'text-gray-600'}`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Vehicle cards */}
      <div className="flex-1 px-4 pb-6 space-y-3">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center pt-24 gap-3">
            <p className="text-gray-600 text-base">
              {tab === 'ready' ? 'No finished vehicles yet' : 'No vehicles need work'}
            </p>
            {tab === 'active' && (
              <Link
                href="/quick-entry"
                className="text-blue-500 text-sm font-medium"
              >
                Check in a vehicle
              </Link>
            )}
          </div>
        ) : (
          visible.map(order => (
            <VehicleCard
              key={order.id}
              order={order}
              highlighted={order.id === highlightId}
            />
          ))
        )}
      </div>

    </div>
  )
}
