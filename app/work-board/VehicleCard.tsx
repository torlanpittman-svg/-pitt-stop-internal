'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { OrderWithContext } from '@/apps/workflow/db'

const STATUS_STYLES: Record<string, { label: string; bg: string; text: string }> = {
  arrived:    { label: 'Waiting',     bg: 'bg-yellow-900/40', text: 'text-yellow-400' },
  in_progress:{ label: 'In Progress', bg: 'bg-blue-900/40',   text: 'text-blue-400'   },
  paused:     { label: 'Paused',      bg: 'bg-orange-900/40', text: 'text-orange-400' },
  drying:     { label: 'Drying',      bg: 'bg-teal-900/40',   text: 'text-teal-400'   },
  qc_ready:   { label: 'QC Ready',    bg: 'bg-purple-900/40', text: 'text-purple-400' },
  ready:      { label: 'Ready',       bg: 'bg-green-900/40',  text: 'text-green-400'  },
}

const FOCUS_LABELS: Record<string, string> = {
  interior_only:  'Interior',
  exterior_only:  'Exterior',
  full_detail:    'Full Detail',
  custom:         'Custom',
}

function elapsed(from: Date | string | null): string {
  if (!from) return ''
  const ms  = Date.now() - new Date(from).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m`
  const hr  = Math.floor(min / 60)
  const rm  = min % 60
  return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`
}

export default function VehicleCard({
  order,
  highlighted = false,
}: {
  order: OrderWithContext
  highlighted?: boolean
}) {
  const { vehicle } = order
  const style      = STATUS_STYLES[order.status] ?? STATUS_STYLES['arrived']
  const activeTech = order.activeTechs[0]?.employeeName ?? null
  const focusLabel = FOCUS_LABELS[order.serviceFocus ?? ''] ?? order.serviceFocus ?? null

  // Deferred so server and client agree on the initial render; updates every minute
  const [timeOnLot, setTimeOnLot] = useState('')
  useEffect(() => {
    const update = () => setTimeOnLot(elapsed(order.arrivedAt))
    update()
    const id = setInterval(update, 60_000)
    return () => clearInterval(id)
  }, [order.arrivedAt])

  const vehicleName = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unknown Vehicle'
  const colorHint   = vehicle.color ? ` · ${vehicle.color}` : ''

  return (
    <Link
      href={`/orders/${order.id}`}
      className={`block bg-gray-900 rounded-2xl px-5 py-4 active:bg-gray-800 transition-all border ${
        highlighted
          ? 'border-green-500 shadow-lg shadow-green-900/30'
          : 'border-gray-800'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-white font-bold text-lg leading-tight truncate">
            {vehicleName}
          </p>
          <p className="text-gray-500 text-sm mt-0.5 truncate">
            {order.orderNumber}{colorHint}
          </p>
        </div>
        <span className={`flex-none text-xs font-semibold px-2.5 py-1 rounded-full ${style.bg} ${style.text}`}>
          {style.label}
        </span>
      </div>

      {/* Selected services (Quick Entry). Compact chips; wraps on phone. No prices. */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {order.services && order.services.length > 0 ? (
          order.services.map((s, i) => (
            <span key={i} className="max-w-full truncate text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-md">
              {s}
            </span>
          ))
        ) : (
          <span className="text-xs text-gray-600 italic">No services listed.</span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3 flex-wrap">
        {focusLabel && (
          <span className="text-xs bg-gray-800 text-gray-400 px-2.5 py-1 rounded-full">
            {focusLabel}
          </span>
        )}
        {activeTech && (
          <span className="text-xs text-gray-400">
            {activeTech}
          </span>
        )}
        {timeOnLot && (
          <span className="text-xs text-gray-600 ml-auto">
            {timeOnLot} on lot
          </span>
        )}
      </div>
    </Link>
  )
}
