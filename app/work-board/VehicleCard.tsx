'use client'

import Link from 'next/link'
import type { OrderWithContext } from '@/apps/workflow/db'

// Employee-facing card status: is the Job still active, or finished? The detailed
// lifecycle (in_progress/paused/drying/qc_ready) stays in the data model + manager
// views — employees just see Active vs Ready.
function simpleStatus(status: string): { label: string; bg: string; text: string } {
  if (status === 'ready')     return { label: 'Ready',     bg: 'bg-green-900/40', text: 'text-green-400' }
  if (status === 'delivered') return { label: 'Delivered', bg: 'bg-gray-800',     text: 'text-gray-400'  }
  if (status === 'cancelled') return { label: 'Cancelled', bg: 'bg-red-900/40',   text: 'text-red-400'   }
  return { label: 'Active', bg: 'bg-blue-900/40', text: 'text-blue-400' }
}

export default function VehicleCard({
  order,
  highlighted = false,
}: {
  order: OrderWithContext
  highlighted?: boolean
}) {
  const { vehicle } = order
  const style = simpleStatus(order.status)

  const vehicleName = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unknown Vehicle'
  // Card title = retail customer or dealer name; vehicle info goes underneath.
  const title = order.customerName?.trim() || 'Unknown Customer'

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
            {title}
          </p>
          <p className="text-gray-500 text-sm mt-0.5 truncate">
            {vehicleName}
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
    </Link>
  )
}
