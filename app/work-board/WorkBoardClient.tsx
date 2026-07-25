'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import type { OrderWithContext } from '@/apps/workflow/db'
import VehicleCard from './VehicleCard'

const POLL_INTERVAL = 10_000

type FilterTab = 'all' | 'active' | 'waiting' | 'finishing'

const ACTIVE_STATUSES   = new Set(['in_progress', 'paused', 'drying'])
const WAITING_STATUSES  = new Set(['arrived'])
const FINISHING_STATUSES = new Set(['qc_ready', 'ready'])

function filterOrders(orders: OrderWithContext[], tab: FilterTab): OrderWithContext[] {
  if (tab === 'all')       return orders
  if (tab === 'active')    return orders.filter(o => ACTIVE_STATUSES.has(o.status))
  if (tab === 'waiting')   return orders.filter(o => WAITING_STATUSES.has(o.status))
  if (tab === 'finishing') return orders.filter(o => FINISHING_STATUSES.has(o.status))
  return orders
}

export default function WorkBoardClient({ initialOrders }: { initialOrders: OrderWithContext[] }) {
  const [orders, setOrders]       = useState<OrderWithContext[]>(initialOrders)
  const [tab, setTab]             = useState<FilterTab>('all')
  const [lastRefresh, setLast]    = useState(Date.now())
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res  = await fetch('/api/workflow/orders', { cache: 'no-store' })
      const data = await res.json() as { orders: OrderWithContext[] }
      setOrders(data.orders ?? [])
      setLast(Date.now())
    } catch {
      // silent — stale data is better than an error banner
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const id = setInterval(refresh, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [refresh])

  const visible = filterOrders(orders, tab)

  const counts = {
    all:       orders.length,
    waiting:   orders.filter(o => WAITING_STATUSES.has(o.status)).length,
    active:    orders.filter(o => ACTIVE_STATUSES.has(o.status)).length,
    finishing: orders.filter(o => FINISHING_STATUSES.has(o.status)).length,
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">

      {/* Header */}
      <div className="px-4 pt-10 pb-4 flex items-center justify-between">
        <div>
          <h1 className="text-white font-bold text-2xl leading-tight">Work Board</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {orders.length === 0 ? 'No active vehicles' : `${orders.length} vehicle${orders.length !== 1 ? 's' : ''} on lot`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {refreshing && (
            <div className="w-4 h-4 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
          )}
          <Link
            href="/check-in"
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
            { key: 'all',       label: 'All',       count: counts.all       },
            { key: 'waiting',   label: 'Waiting',   count: counts.waiting   },
            { key: 'active',    label: 'Active',    count: counts.active    },
            { key: 'finishing', label: 'Finishing', count: counts.finishing  },
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
              {tab === 'all' ? 'No vehicles on the lot' : `No ${tab} vehicles`}
            </p>
            {tab === 'all' && (
              <Link
                href="/check-in"
                className="text-blue-500 text-sm font-medium"
              >
                Check in a vehicle
              </Link>
            )}
          </div>
        ) : (
          visible.map(order => (
            <VehicleCard key={order.id} order={order} />
          ))
        )}
      </div>

    </div>
  )
}
