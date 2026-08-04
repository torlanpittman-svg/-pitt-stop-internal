'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { OrderWithContext, ServiceOrderEvent } from '@/apps/workflow/db'

// ── Status display config ─────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  arrived:    { label: 'Waiting',     color: 'text-yellow-400' },
  in_progress:{ label: 'In Progress', color: 'text-blue-400'   },
  paused:     { label: 'Paused',      color: 'text-orange-400' },
  drying:     { label: 'Drying',      color: 'text-teal-400'   },
  qc_ready:   { label: 'QC Ready',    color: 'text-purple-400' },
  ready:      { label: 'Ready',       color: 'text-green-400'  },
  delivered:  { label: 'Delivered',   color: 'text-gray-400'   },
  cancelled:  { label: 'Cancelled',   color: 'text-red-400'    },
}

const FOCUS_LABELS: Record<string, string> = {
  interior_only: 'Interior Only',
  exterior_only: 'Exterior Only',
  full_detail:   'Full Detail',
  custom:        'Custom',
}

const EVENT_LABELS: Record<string, string> = {
  checked_in:     'Checked in',
  status_changed: 'Status changed',
  assigned:       'Assigned',
  service_added:  'Service added',
}

// Simplified common services shown first in the picker (matches Quick Entry).
const COMMON_SERVICES = ['Interior Detail', 'Exterior Wash', 'Polish', 'Wax', 'Mini Detail']

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcElapsed(from: Date | string | null): string {
  if (!from) return ''
  const ms  = Date.now() - new Date(from).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  const rm = min % 60
  return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`
}

// Rendered only after mount so Date.now() and toLocaleTimeString don't
// differ between the server render and client hydration.
function ElapsedTime({ from }: { from: Date | string | null }) {
  const [text, setText] = useState('')
  useEffect(() => {
    const update = () => setText(calcElapsed(from))
    update()
    const id = setInterval(update, 60_000)
    return () => clearInterval(id)
  }, [from])
  return <>{text}</>
}

function EventTime({ date }: { date: Date | string | null }) {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!date) return
    setText(new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
  }, [date])
  return <>{text}</>
}

// ── Employee Picker ───────────────────────────────────────────────────────────

type Employee = { id: string; name: string }

function EmployeePicker({
  onSelect,
  onCancel,
}: {
  onSelect: (name: string) => void
  onCancel: () => void
}) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    fetch('/api/workflow/employees')
      .then(r => r.json())
      .then(d => setEmployees(d.employees ?? []))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-white font-bold text-xl">Who is working this?</h2>
          <button onClick={onCancel} className="text-gray-500 text-sm">Cancel</button>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-8 h-8 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" />
          </div>
        ) : employees.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-500 mb-2">No employees set up yet</p>
            <a href="/admin/workflow" className="text-blue-500 text-sm">Add employees in Admin</a>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {employees.map(emp => (
              <button
                key={emp.id}
                onClick={() => onSelect(emp.name)}
                className="bg-gray-800 border border-gray-700 text-white font-semibold text-base py-4 px-4 rounded-2xl active:bg-gray-700 transition-colors text-center"
              >
                {emp.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Action Buttons by Status ──────────────────────────────────────────────────

type ActionConfig = {
  label:        string
  newStatus:    string
  style:        string
  needsEmployee: boolean
}

const STATUS_ACTIONS: Record<string, ActionConfig[]> = {
  arrived: [
    { label: 'Start Work',  newStatus: 'in_progress', style: 'bg-blue-600',   needsEmployee: true  },
    { label: 'Cancel',      newStatus: 'cancelled',   style: 'bg-gray-800 border border-gray-700', needsEmployee: false },
  ],
  in_progress: [
    { label: 'QC Ready',   newStatus: 'qc_ready',    style: 'bg-purple-600', needsEmployee: false },
    { label: 'Set Drying', newStatus: 'drying',       style: 'bg-teal-700',   needsEmployee: false },
    { label: 'Pause',      newStatus: 'paused',       style: 'bg-orange-700', needsEmployee: false },
  ],
  paused: [
    { label: 'Resume Work', newStatus: 'in_progress', style: 'bg-blue-600',   needsEmployee: true  },
    { label: 'Cancel',      newStatus: 'cancelled',   style: 'bg-gray-800 border border-gray-700', needsEmployee: false },
  ],
  drying: [
    { label: 'QC Ready',    newStatus: 'qc_ready',    style: 'bg-purple-600', needsEmployee: false },
    { label: 'Resume Work', newStatus: 'in_progress', style: 'bg-gray-800 border border-gray-700', needsEmployee: true  },
  ],
  qc_ready: [
    { label: 'Mark Ready',       newStatus: 'ready',       style: 'bg-green-600',  needsEmployee: false },
    { label: 'Send Back to Work', newStatus: 'in_progress', style: 'bg-gray-800 border border-gray-700', needsEmployee: true  },
  ],
  ready: [
    { label: 'Deliver Vehicle', newStatus: 'delivered', style: 'bg-green-600', needsEmployee: false },
  ],
  delivered: [],
  cancelled: [],
}

// ── Add-Service Picker ────────────────────────────────────────────────────────

function ServicePicker({ onAdd, onCancel, busy, error }: {
  onAdd: (services: string[]) => void
  onCancel: () => void
  busy: boolean
  error: string | null
}) {
  const [options, setOptions] = useState<string[]>(COMMON_SERVICES)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [otherText, setOtherText] = useState('')

  // Pull the active catalog; keep the common ones first, append any others.
  useEffect(() => {
    fetch('/api/quick-entry/catalog').then((r) => r.json()).then((d) => {
      const names: string[] = (d?.packages ?? []).map((p: { name: string }) => p.name)
      const merged = [...COMMON_SERVICES, ...names.filter((n) => !COMMON_SERVICES.includes(n))]
      setOptions(merged)
    }).catch(() => { /* keep the built-in common list */ })
  }, [])

  const toggle = (name: string) => setSelected((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })
  const chosen = [...selected, ...(otherText.trim() ? [otherText.trim()] : [])]

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-white font-bold text-xl">Add a service</h2>
          <button onClick={onCancel} className="text-gray-500 text-sm">Cancel</button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {options.map((name) => (
            <button key={name} onClick={() => toggle(name)}
              className={`relative rounded-2xl border px-3 py-4 text-left text-sm ${selected.has(name) ? 'bg-blue-600/20 border-blue-500 text-white font-semibold' : 'bg-gray-800 border-gray-700 text-gray-200 active:bg-gray-700'}`}>
              {name}
              {selected.has(name) && <span className="absolute top-2 right-2 text-blue-400">✓</span>}
            </button>
          ))}
        </div>

        {/* Other — free text (typed or dictated). No price. */}
        <div className="mt-3">
          <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Other</p>
          <input value={otherText} onChange={(e) => setOtherText(e.target.value)} placeholder="What are we doing?"
            className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        {error && <p className="text-amber-400 text-sm mt-3">{error}</p>}

        <button onClick={() => onAdd(chosen)} disabled={busy || chosen.length === 0}
          className="mt-5 w-full h-14 rounded-2xl bg-green-600 active:bg-green-700 text-white text-lg font-bold disabled:opacity-40">
          {busy ? 'Adding…' : `Add ${chosen.length || ''} Service${chosen.length === 1 ? '' : 's'}`.replace('  ', ' ')}
        </button>
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function OrderDetail({ initialOrder }: { initialOrder: OrderWithContext }) {
  const router = useRouter()

  const [order,       setOrder]       = useState<OrderWithContext>(initialOrder)
  const [pending,     setPending]     = useState<string | null>(null)
  const [picking,     setPicking]     = useState<ActionConfig | null>(null)
  const [error,       setError]       = useState<string | null>(null)
  const [addingService, setAddingService] = useState(false)  // picker open
  const [addBusy,     setAddBusy]     = useState(false)
  const [addError,    setAddError]    = useState<string | null>(null)

  const { vehicle } = order
  const statusCfg   = STATUS_CONFIG[order.status] ?? { label: order.status, color: 'text-gray-400' }
  const actions     = STATUS_ACTIONS[order.status] ?? []
  const activeTech  = order.activeTechs[0]?.employeeName ?? null
  const vehicleName = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unknown Vehicle'
  const title       = order.customerName?.trim() || vehicleName || 'Unknown Customer'
  const services    = order.services ?? []

  // Add services to this order (display-only). Attributes to the active tech when one
  // is working, else 'staff'. Confirms before adding an already-present service.
  const addServices = useCallback(async (names: string[], confirmDuplicates = false) => {
    if (names.length === 0) return
    setAddBusy(true); setAddError(null)
    try {
      const res = await fetch(`/api/workflow/orders/${order.id}/services`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ services: names, addedBy: activeTech ?? 'staff', confirmDuplicates }),
      })
      const data = await res.json()
      if (res.status === 409 && data.needsConfirm) {
        if (confirm(`Already added: ${data.duplicates.join(', ')}. Add again anyway?`)) {
          await addServices(names, true)
        }
        return
      }
      if (!res.ok || !data.ok) { setAddError(data.error ?? 'Could not add the service.'); return }
      setOrder(data.order)          // update the detail page immediately
      setAddingService(false)
    } catch { setAddError('Network error — try again.') } finally { setAddBusy(false) }
  }, [order.id, activeTech])

  const reload = useCallback(async () => {
    const res = await fetch(`/api/workflow/orders/${order.id}`, { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      setOrder(data.order)
    }
  }, [order.id])

  const doTransition = useCallback(async (action: ActionConfig, employeeName: string | null) => {
    setPending(action.newStatus)
    setError(null)
    try {
      const res = await fetch(`/api/workflow/orders/${order.id}/transition`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus: action.newStatus, employeeName }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Action failed'); return }

      if (action.newStatus === 'delivered') {
        router.push('/work-board')
        return
      }
      await reload()
    } catch {
      setError('Network error — try again')
    } finally {
      setPending(null)
    }
  }, [order.id, reload, router])

  const handleAction = useCallback((action: ActionConfig) => {
    setError(null)
    if (action.needsEmployee) {
      setPicking(action)
    } else {
      doTransition(action, null)
    }
  }, [doTransition])

  const handleEmployeePick = useCallback((name: string) => {
    if (!picking) return
    setPicking(null)
    doTransition(picking, name)
  }, [picking, doTransition])

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">

      {/* Header */}
      <div className="px-6 pt-10 pb-6">
        <button
          onClick={() => router.push('/work-board')}
          className="text-gray-500 text-sm mb-6 block"
        >
          ← Work Board
        </button>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-white font-bold text-2xl leading-tight truncate">{title}</h1>
            <p className="text-gray-400 text-base mt-0.5">
              {vehicleName}{vehicle.color ? ` · ${vehicle.color}` : ''}
            </p>
            {/* SO number kept for reference/debugging (not shown on the Work Board card) */}
            <p className="text-gray-700 text-xs mt-1">{order.orderNumber}</p>
          </div>
          <span className={`flex-none font-bold text-base mt-1 ${statusCfg.color}`}>
            {statusCfg.label}
          </span>
        </div>

        {/* Service focus + tech + timer row */}
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          {order.serviceFocus && (
            <span className="text-xs bg-gray-800 text-gray-400 px-2.5 py-1 rounded-full">
              {FOCUS_LABELS[order.serviceFocus] ?? order.serviceFocus}
            </span>
          )}
          {activeTech && (
            <span className="text-xs text-gray-400">{activeTech} working</span>
          )}
          {order.arrivedAt && (
            <span className="text-xs text-gray-600">
              <ElapsedTime from={order.arrivedAt} /> on lot
            </span>
          )}
        </div>
      </div>

      {/* Services (operational). Chips + Add Service. */}
      <div className="px-6 mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Services</h2>
          <button onClick={() => { setAddError(null); setAddingService(true) }}
            className="text-blue-400 text-sm font-semibold active:opacity-70">+ Add Service</button>
        </div>
        {services.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {services.map((s, i) => (
              <span key={i} className="max-w-full truncate text-sm bg-gray-800 text-gray-200 px-2.5 py-1 rounded-lg">{s}</span>
            ))}
          </div>
        ) : (
          <p className="text-gray-600 text-sm italic">No services listed.</p>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mb-4 bg-red-900/40 border border-red-700 rounded-xl px-4 py-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Action buttons */}
      {actions.length > 0 && (
        <div className="px-6 space-y-3 mb-8">
          {actions.map(action => (
            <button
              key={action.newStatus}
              onClick={() => handleAction(action)}
              disabled={pending !== null}
              className={`w-full text-white font-bold text-xl py-5 rounded-2xl transition-colors active:opacity-80 disabled:opacity-40 ${action.style}`}
            >
              {pending === action.newStatus ? 'Updating…' : action.label}
            </button>
          ))}
        </div>
      )}

      {(order.status === 'delivered' || order.status === 'cancelled') && (
        <div className="px-6 mb-8">
          <p className="text-gray-600 text-center text-base py-4">
            {order.status === 'delivered' ? 'Vehicle has been delivered.' : 'Order was cancelled.'}
          </p>
        </div>
      )}

      {/* Event timeline */}
      {order.recentEvents.length > 0 && (
        <div className="px-6 flex-1">
          <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-3">
            Activity
          </h2>
          <div className="space-y-2">
            {order.recentEvents.map((event: ServiceOrderEvent) => (
              <div key={event.id} className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-gray-700 mt-2 shrink-0" />
                <div>
                  <p className="text-gray-300 text-sm">
                    {event.newStatus
                      ? `${event.employeeName ? event.employeeName + ' — ' : ''}${STATUS_CONFIG[event.newStatus]?.label ?? event.newStatus}`
                      : event.eventType === 'service_added'
                        ? `Service added: ${event.note ?? ''}${event.employeeName ? ` · ${event.employeeName}` : ''}`
                        : `${EVENT_LABELS[event.eventType] ?? event.eventType}${event.employeeName ? ` · ${event.employeeName}` : ''}`
                    }
                  </p>
                  <p className="text-gray-600 text-xs"><EventTime date={event.createdAt} /></p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Employee picker */}
      {picking && (
        <EmployeePicker
          onSelect={handleEmployeePick}
          onCancel={() => setPicking(null)}
        />
      )}

      {/* Add-service picker */}
      {addingService && (
        <ServicePicker
          onAdd={(names) => addServices(names)}
          onCancel={() => setAddingService(false)}
          busy={addBusy}
          error={addError}
        />
      )}

    </main>
  )
}
