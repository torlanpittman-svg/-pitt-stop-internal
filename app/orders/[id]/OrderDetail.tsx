'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { OrderWithContext, ServiceOrderEvent } from '@/apps/workflow/db'
import { useIdentity } from '@/app/components/IdentityBar'
import NavHeader from '@/app/components/NavHeader'

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
  completed:      'Completed (Ready)',
  reopened:       'Reopened',
}

// Simplified common services shown first in the picker (matches Quick Entry).
const COMMON_SERVICES = ['Interior Detail', 'Exterior Wash', 'Polish', 'Wax', 'Mini Detail']

function reopenReason(note: string | null): string {
  try { const d = JSON.parse(note ?? '{}'); return d.reason ? ` — ${d.reason}` : '' } catch { return '' }
}

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

// ── Completion checklist ("Is this vehicle truly finished?") ──────────────────

function CompletionModal({ services, qcRequired, busy, error, onConfirm, onCancel, initialAck }: {
  services: string[]
  qcRequired: boolean
  busy: boolean
  error: string | null
  onConfirm: (p: { servicesAck: string[]; noRemaining: boolean; finalTouches: boolean; qcPassed: boolean }) => void
  onCancel: () => void
  initialAck?: Set<string>
}) {
  // Pre-seed with services the employee already checked off on the to-do list.
  const [ack, setAck] = useState<Set<string>>(() => new Set(initialAck ?? []))
  const [noRemaining, setNoRemaining] = useState(false)
  const [finalTouches, setFinalTouches] = useState(false)
  const [qcPassed, setQcPassed] = useState(false)
  const noServices = services.length === 0
  const allAck = services.every((s) => ack.has(s))
  const ready = !noServices && allAck && noRemaining && finalTouches && (!qcRequired || qcPassed)
  const toggle = (s: string) => setAck((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n })

  const Check = ({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) => (
    <button onClick={() => set(!on)} className={`w-full flex items-center gap-3 rounded-2xl border px-4 py-3 text-left ${on ? 'bg-green-600/15 border-green-600' : 'bg-gray-800 border-gray-700'}`}>
      <span className={`w-6 h-6 rounded-md flex items-center justify-center text-sm ${on ? 'bg-green-600 text-white' : 'border border-gray-600 text-transparent'}`}>✓</span>
      <span className="text-white text-sm">{label}</span>
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1"><h2 className="text-white font-bold text-xl">Is this vehicle truly finished?</h2><button onClick={onCancel} className="text-gray-500 text-sm">Cancel</button></div>

        {noServices ? (
          <div className="mt-4 rounded-2xl bg-amber-950/40 border border-amber-700/50 px-4 py-4">
            <p className="text-amber-300 font-medium text-sm">No services are listed on this Job.</p>
            <p className="text-amber-400/80 text-xs mt-1">Add or confirm the work performed with <b>＋ Add Service</b> before marking it Ready.</p>
          </div>
        ) : (
          <>
            <p className="text-gray-500 text-xs uppercase tracking-widest mt-4 mb-2">Services to confirm</p>
            <div className="space-y-2">
              {services.map((s) => <Check key={s} on={ack.has(s)} set={() => toggle(s)} label={s} />)}
            </div>
            <p className="text-gray-500 text-xs uppercase tracking-widest mt-5 mb-2">Final checks</p>
            <div className="space-y-2">
              <Check on={noRemaining} set={setNoRemaining} label="No remaining or added work is unresolved" />
              <Check on={finalTouches} set={setFinalTouches} label="Final touches are complete" />
              {qcRequired && <Check on={qcPassed} set={setQcPassed} label="QC passed" />}
            </div>
          </>
        )}

        {error && <p className="text-amber-400 text-sm mt-3">{error}</p>}
        <button onClick={() => onConfirm({ servicesAck: [...ack], noRemaining, finalTouches, qcPassed })} disabled={!ready || busy}
          className="mt-5 w-full h-14 rounded-2xl bg-green-600 active:bg-green-700 text-white text-lg font-bold disabled:opacity-40">
          {busy ? 'Marking Ready…' : 'Confirm — vehicle is Ready'}
        </button>
      </div>
    </div>
  )
}

// ── Reopen (sensitive correction: reason + manager PIN step-up) ───────────────

function ReopenModal({ busy, error, onConfirm, onCancel }: {
  busy: boolean; error: string | null
  onConfirm: (reason: string, pin: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10">
        <div className="flex items-center justify-between mb-1"><h2 className="text-white font-bold text-xl">Reopen this Job</h2><button onClick={onCancel} className="text-gray-500 text-sm">Cancel</button></div>
        <p className="text-gray-500 text-xs mb-4">This clears the completion (it will count only when finished again). The original completion is kept in history.</p>
        <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Reason</p>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being reopened?" rows={2}
          className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-base" />
        <p className="text-gray-500 text-xs uppercase tracking-widest mt-4 mb-1">Manager PIN</p>
        <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric"
          placeholder="PIN" className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-2xl tracking-[0.4em] text-center" />
        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
        <button onClick={() => onConfirm(reason, pin)} disabled={busy || !reason.trim() || pin.length < 4}
          className="mt-5 w-full h-14 rounded-2xl bg-amber-600 active:bg-amber-700 text-white text-lg font-bold disabled:opacity-40">
          {busy ? 'Reopening…' : 'Confirm reopen'}
        </button>
      </div>
    </div>
  )
}

// ── Edit Vehicle (manager correction of a wrong OCR read) ─────────────────────

// Module-level (stable identity) so typing never remounts the input — defining this
// INSIDE the modal made React create a new component type each render, which unmounts
// the <input> and drops focus/keyboard on every keystroke.
function VehField({ label, value, onChange, numeric = false, upper = false }: {
  label: string
  value: string
  onChange: (v: string) => void
  numeric?: boolean
  upper?: boolean
}) {
  return (
    <div>
      <label className="text-gray-500 text-xs uppercase tracking-widest">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={numeric ? 'numeric' : undefined}
        autoCapitalize={upper ? 'characters' : 'words'}
        className="mt-1 w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}

function VehicleEditModal({ orderId, onClose, onSaved }: {
  orderId: string
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [form, setForm] = useState({ year: '', make: '', model: '', vin: '', stockNumber: '' })
  const [ctx, setCtx] = useState({ isDealer: false, qbLinked: false })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/workflow/orders/${orderId}/vehicle`)
      .then((r) => r.json())
      .then((d) => {
        setForm({ year: d.year ?? '', make: d.make ?? '', model: d.model ?? '', vin: d.vin ?? '', stockNumber: d.stockNumber ?? '' })
        setCtx({ isDealer: !!d.isDealer, qbLinked: !!d.qbLinked })
      })
      .catch(() => setErr('Could not load vehicle info.'))
      .finally(() => setLoading(false))
  }, [orderId])

  const save = async () => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/vehicle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-QB-Write-Approved': 'true' },
        body: JSON.stringify(form),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Could not save the correction.'); return }
      const msg = d.qb?.action === 'updated' ? 'Vehicle updated · QuickBooks invoice corrected'
        : d.qb?.action === 'needs_review' ? 'Vehicle updated · QuickBooks sync needs review'
        : (d.changed?.length ? 'Vehicle updated' : 'No changes made')
      onSaved(msg)
    } catch { setErr('Network error — try again.') } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-xl">Edit Vehicle</h2>
          <button onClick={onClose} className="text-gray-500 text-sm">Cancel</button>
        </div>
        {loading ? (
          <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" /></div>
        ) : (
          <div className="space-y-4">
            <VehField label="Year" value={form.year} onChange={(v) => setForm((f) => ({ ...f, year: v }))} numeric />
            <VehField label="Make" value={form.make} onChange={(v) => setForm((f) => ({ ...f, make: v }))} />
            <VehField label="Model" value={form.model} onChange={(v) => setForm((f) => ({ ...f, model: v }))} />
            <VehField label="VIN" value={form.vin} onChange={(v) => setForm((f) => ({ ...f, vin: v }))} upper />
            {ctx.isDealer && <VehField label="Stock / tag number" value={form.stockNumber} onChange={(v) => setForm((f) => ({ ...f, stockNumber: v }))} upper />}
            {ctx.qbLinked && <p className="text-gray-500 text-xs">This Job has a QuickBooks invoice — saving will also correct the invoice line description.</p>}
            {err && <p className="text-amber-400 text-sm">{err}</p>}
            <button onClick={save} disabled={busy}
              className="w-full h-14 rounded-2xl bg-green-600 active:bg-green-700 text-white text-lg font-bold disabled:opacity-40">
              {busy ? 'Saving…' : 'Save correction'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Invoice Draft (manager/admin) ─────────────────────────────────────────────
// A clean "what would this customer be invoiced right now?" view built from the
// authoritative Job estimate. Read-only totals; the only writes are the Remove/Restore
// charge toggles (server-enforced: shop/payment = manager+admin, tax exempt = admin+reason).
// NO QuickBooks — this never creates or sends an invoice.
interface InvoiceDraftData {
  priced: boolean; isDealer: boolean
  customer: string | null; vehicle: string; services: string[]
  workPriceCents: number
  shopSupplies: { cents: number; waived: boolean }
  paymentCharge: { cents: number; waived: boolean; label: string }
  tax: { cents: number; applicable: boolean; needsReview: boolean; exempt: boolean }
  totalCents: number; role: string
}
const money = (c: number) => `$${(c / 100).toFixed(2)}`

function ChargeRow({ label, cents, waived, canEdit, busy, onToggle }: {
  label: string; cents: number; waived: boolean; canEdit: boolean; busy: boolean; onToggle: (removed: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-800">
      <div className="min-w-0">
        <p className={`text-sm ${waived ? 'text-gray-600 line-through' : 'text-gray-300'}`}>{label}</p>
        {waived && <p className="text-gray-600 text-xs">Removed — not billed</p>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`text-sm tabular-nums ${waived ? 'text-gray-600 line-through' : 'text-gray-200'}`}>{money(cents)}</span>
        {canEdit && (
          <button onClick={() => onToggle(!waived)} disabled={busy}
            className={`text-xs font-semibold px-2.5 py-1 rounded-lg active:opacity-70 disabled:opacity-40 ${waived ? 'text-blue-400 border border-blue-900/60' : 'text-gray-400 border border-gray-700'}`}>
            {waived ? 'Restore' : 'Remove'}
          </button>
        )}
      </div>
    </div>
  )
}

function InvoiceDraftModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [draft, setDraft] = useState<InvoiceDraftData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [taxReasonOpen, setTaxReasonOpen] = useState(false)
  const [taxReason, setTaxReason] = useState('')

  useEffect(() => {
    let ok = true
    fetch(`/api/workflow/orders/${orderId}/invoice`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (ok) { if (d.draft) setDraft(d.draft); else setErr(d.error ?? 'Could not load the invoice draft.') } })
      .catch(() => { if (ok) setErr('Could not load the invoice draft.') })
      .finally(() => { if (ok) setLoading(false) })
    return () => { ok = false }
  }, [orderId])

  const override = useCallback(async (field: 'shop_supplies' | 'payment' | 'tax_exempt', removed: boolean, reason?: string) => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/override`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, removed, reason }),
      })
      const data = await res.json()
      if (!res.ok) { setErr(data.error ?? 'That change was not allowed.'); return }
      setDraft(data.draft)
      setTaxReasonOpen(false); setTaxReason('')
    } catch { setErr('Network error — please try again.') }
    finally { setBusy(false) }
  }, [orderId])

  const isAdmin = draft?.role === 'admin'

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-xl">Invoice Draft</h2>
          <button onClick={onClose} className="text-gray-500 text-sm">Close</button>
        </div>

        {loading && <p className="text-gray-500 text-sm py-8 text-center">Loading…</p>}

        {!loading && draft && (
          <>
            {/* Header: who / what */}
            <div className="mb-4">
              {draft.customer && <p className="text-white text-base font-semibold">{draft.customer}</p>}
              <p className="text-gray-400 text-sm">{draft.vehicle}</p>
              {draft.services.length > 0 && <p className="text-gray-500 text-xs mt-1">{draft.services.join(' · ')}</p>}
            </div>

            {draft.isDealer ? (
              <p className="text-gray-400 text-sm bg-gray-800/60 rounded-xl px-4 py-4">
                This is a Dealer Job — billed through Dealer Check-In / QuickBooks. No retail Shop Supplies, Payment Charge, or sales tax apply.
              </p>
            ) : !draft.priced ? (
              <p className="text-gray-400 text-sm bg-gray-800/60 rounded-xl px-4 py-4">
                No Work Price yet. Set a Work Price in Quick Entry (manager pricing) before an invoice draft can be prepared.
              </p>
            ) : (
              <>
                {/* Work price */}
                <div className="flex items-center justify-between py-2.5 border-b border-gray-800">
                  <p className="text-sm text-gray-300">Work</p>
                  <span className="text-sm tabular-nums text-gray-200">{money(draft.workPriceCents)}</span>
                </div>

                {/* Shop supplies — manager + admin */}
                <ChargeRow label="Shop supplies" cents={draft.shopSupplies.cents} waived={draft.shopSupplies.waived}
                  canEdit busy={busy} onToggle={(removed) => override('shop_supplies', removed)} />

                {/* Payment charge — manager + admin */}
                <ChargeRow label={draft.paymentCharge.label} cents={draft.paymentCharge.cents} waived={draft.paymentCharge.waived}
                  canEdit busy={busy} onToggle={(removed) => override('payment', removed)} />

                {/* Tax — only when it applies; exemption is admin-only + reason */}
                {(draft.tax.applicable || draft.tax.exempt) && (
                  <div className="py-2.5 border-b border-gray-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className={`text-sm ${draft.tax.exempt ? 'text-gray-600 line-through' : 'text-gray-300'}`}>
                          Sales tax{draft.tax.needsReview && !draft.tax.exempt ? ' (pending review)' : ''}
                        </p>
                        {draft.tax.exempt && <p className="text-gray-600 text-xs">Tax exempt</p>}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-sm tabular-nums ${draft.tax.exempt ? 'text-gray-600 line-through' : 'text-gray-200'}`}>{money(draft.tax.cents)}</span>
                        {isAdmin && (draft.tax.exempt
                          ? <button onClick={() => override('tax_exempt', false)} disabled={busy}
                              className="text-xs font-semibold px-2.5 py-1 rounded-lg text-blue-400 border border-blue-900/60 active:opacity-70 disabled:opacity-40">Restore</button>
                          : <button onClick={() => setTaxReasonOpen((v) => !v)} disabled={busy}
                              className="text-xs font-semibold px-2.5 py-1 rounded-lg text-gray-400 border border-gray-700 active:opacity-70 disabled:opacity-40">Exempt</button>
                        )}
                      </div>
                    </div>
                    {isAdmin && taxReasonOpen && !draft.tax.exempt && (
                      <div className="mt-3">
                        <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Reason for exemption (required)</p>
                        <textarea value={taxReason} onChange={(e) => setTaxReason(e.target.value)} rows={2}
                          placeholder="e.g. resale certificate on file / government entity"
                          className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-sm" />
                        <button onClick={() => override('tax_exempt', true, taxReason)} disabled={busy || !taxReason.trim()}
                          className="mt-2 w-full h-11 rounded-xl bg-amber-600 active:bg-amber-700 text-white text-sm font-bold disabled:opacity-40">
                          {busy ? 'Saving…' : 'Confirm tax exempt'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Total */}
                <div className="flex items-center justify-between pt-4">
                  <p className="text-white font-bold text-base">Total</p>
                  <span className="text-white font-bold text-lg tabular-nums">{money(draft.totalCents)}</span>
                </div>
                <p className="text-gray-600 text-xs mt-4">Draft only — no invoice has been created or sent. Every change is recorded.</p>
              </>
            )}
          </>
        )}

        {err && <p className="text-red-400 text-sm mt-4">{err}</p>}
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
  const [completing,  setCompleting]  = useState(false)   // completion checklist open
  const [completeBusy, setCompleteBusy] = useState(false)
  const [completeMsg, setCompleteMsg] = useState<string | null>(null)
  const [reopening,   setReopening]   = useState(false)   // reopen (reason + PIN) open
  const [reopenBusy,  setReopenBusy]  = useState(false)
  const [reopenMsg,   setReopenMsg]   = useState<string | null>(null)
  const [acked,       setAcked]       = useState<Set<string>>(new Set())  // to-do checkoffs
  const [editingVehicle, setEditingVehicle] = useState(false)
  const [vehToast,    setVehToast]    = useState<string | null>(null)
  const [showInvoice, setShowInvoice] = useState(false)   // Invoice Draft (manager/admin)
  const identity = useIdentity()
  const isManager = identity.effectiveRole === 'manager' || identity.effectiveRole === 'admin'

  const { vehicle } = order
  const statusCfg   = STATUS_CONFIG[order.status] ?? { label: order.status, color: 'text-gray-400' }
  const actions     = STATUS_ACTIONS[order.status] ?? []
  const activeTech  = order.activeTechs[0]?.employeeName ?? null
  const vehicleName = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unknown Vehicle'
  const title       = order.customerName?.trim() || vehicleName || 'Unknown Customer'
  const services    = order.services ?? []

  // Employee-facing simplifications:
  // • one status read: is the Job still active, or finished (Ready) / gone.
  const ACTIVE_STATUSES = ['arrived', 'in_progress', 'paused', 'drying', 'qc_ready']
  const isActive = ACTIVE_STATUSES.includes(order.status)
  const simpleStatus =
    order.status === 'ready'     ? { label: 'Ready',     color: 'text-green-400' } :
    order.status === 'delivered' ? { label: 'Delivered', color: 'text-gray-400'  } :
    order.status === 'cancelled' ? { label: 'Cancelled', color: 'text-red-400'   } :
                                   { label: 'Active',    color: 'text-blue-400'  }
  // • Notes: show genuine notes only, not the auto-generated Quick Entry summary.
  const rawNotes  = (order.notes ?? '').trim()
  const showNotes = rawNotes.length > 0 && !/^quick entry ·/i.test(rawNotes)
  const toggleAck = (s: string) => setAcked((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n })
  // Finish Job = the true completion flow, straight from the current active state.
  const finishAction: ActionConfig = { label: 'Finish Job', newStatus: 'ready', style: 'bg-green-600', needsEmployee: false }

  // Refetch the FULL order context (vehicle + assignments + events). The mutation
  // APIs (transition / services / reopen) return a bare service_orders row, so we
  // must reload() here — never setOrder() that partial row, or the next render
  // dereferences order.vehicle and crashes into a dead-end error page.
  const reload = useCallback(async () => {
    const res = await fetch(`/api/workflow/orders/${order.id}`, { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      setOrder(data.order)
    }
  }, [order.id])

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
      setAddingService(false)
      await reload()                // full-context refetch (not the bare API row)
    } catch { setAddError('Network error — try again.') } finally { setAddBusy(false) }
  }, [order.id, activeTech, reload])

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
    // Becoming Ready goes through the completion checklist (server enforces the gate).
    if (action.newStatus === 'ready' && identity.completionEnabled) { setCompleteMsg(null); setCompleting(true); return }
    if (action.needsEmployee) {
      setPicking(action)
    } else {
      doTransition(action, null)
    }
  }, [doTransition, identity.completionEnabled])

  // Confirm completion → mark Ready (server validates every service + final checks).
  const completeJob = useCallback(async (payload: { servicesAck: string[]; noRemaining: boolean; finalTouches: boolean; qcPassed: boolean }) => {
    setCompleteBusy(true); setCompleteMsg(null)
    try {
      const res = await fetch(`/api/workflow/orders/${order.id}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus: 'ready', completion: payload }),
      })
      const d = await res.json()
      if (res.status === 422) {
        setCompleteMsg(d.reason === 'services_unacknowledged' ? `Confirm every service first: ${(d.missing ?? []).join(', ')}`
          : d.reason === 'no_services' ? 'Add or confirm the work performed first.'
          : 'Complete every item before marking Ready.')
        return
      }
      if (!res.ok) { setCompleteMsg(d.error ?? 'Could not mark Ready.'); return }
      // Success: the Job is Ready (completed_at stamped, counted once). Close the
      // modal and return to the Work Board — the now-Ready Job leaves the default
      // Active view and appears under Ready. (Do NOT setOrder the bare API row.)
      setCompleting(false)
      router.push('/work-board')
    } catch { setCompleteMsg('Network error — try again.') } finally { setCompleteBusy(false) }
  }, [order.id, router])

  // Manager correction: reopen a Ready Job (sensitive → reason + PIN step-up).
  const submitReopen = useCallback(async (reason: string, pin: string) => {
    setReopenBusy(true); setReopenMsg(null)
    try {
      const res = await fetch(`/api/workflow/orders/${order.id}/reopen`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, pin }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setReopenMsg(d.error ?? 'Could not reopen.'); return }
      setReopening(false); await reload()   // full-context refetch (not the bare API row)
    } catch { setReopenMsg('Network error — try again.') } finally { setReopenBusy(false) }
  }, [order.id, reload])

  const handleEmployeePick = useCallback((name: string) => {
    if (!picking) return
    setPicking(null)
    doTransition(picking, name)
  }, [picking, doTransition])

  return (
    <main className="min-h-screen bg-gray-950 flex flex-col">

      <NavHeader back={{ href: '/work-board', label: 'Work Board' }} />

      {/* Header — customer/dealer + vehicle + one simple status (active vs finished) */}
      <div className="px-6 pt-6 pb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-white font-bold text-2xl leading-tight truncate">{title}</h1>
            <p className="text-gray-400 text-base mt-0.5">
              {vehicleName}{vehicle.color ? ` · ${vehicle.color}` : ''}
            </p>
            {isManager && (
              <button onClick={() => setEditingVehicle(true)}
                className="text-blue-400 text-sm font-semibold mt-1 active:opacity-70">Edit Vehicle</button>
            )}
          </div>
          <span className={`flex-none font-bold text-base mt-1 ${simpleStatus.color}`}>
            {simpleStatus.label}
          </span>
        </div>
      </div>

      {vehToast && (
        <div className="mx-6 -mt-2 mb-4 bg-green-900/40 border border-green-700/50 rounded-xl px-4 py-3">
          <p className="text-green-300 text-sm font-medium">{vehToast}</p>
        </div>
      )}

      {/* Notes — genuine notes only (not the auto-generated Quick Entry summary) */}
      {showNotes && (
        <div className="px-6 mb-6">
          <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-2">Notes</h2>
          <p className="text-gray-300 text-sm whitespace-pre-wrap">{rawNotes}</p>
        </div>
      )}

      {/* Services — a simple to-do list the employee checks off */}
      <div className="px-6 mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Services</h2>
          <button onClick={() => { setAddError(null); setAddingService(true) }}
            className="text-blue-400 text-sm font-semibold active:opacity-70">+ Add Service</button>
        </div>
        {services.length > 0 ? (
          <div className="space-y-2">
            {services.map((s, i) => {
              const on = acked.has(s)
              return (
                <button key={i} onClick={() => toggleAck(s)}
                  className={`w-full flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left ${on ? 'bg-green-600/15 border-green-600' : 'bg-gray-900 border-gray-800 active:bg-gray-800'}`}>
                  <span className={`w-6 h-6 rounded-md flex items-center justify-center text-sm shrink-0 ${on ? 'bg-green-600 text-white' : 'border border-gray-600 text-transparent'}`}>✓</span>
                  <span className="text-white text-base">{s}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <p className="text-gray-600 text-sm italic">No services yet — tap ＋ Add Service.</p>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mb-4 bg-red-900/40 border border-red-700 rounded-xl px-4 py-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Finish Job — one tap into the true Completion flow, from any active state */}
      {isActive && (
        <div className="px-6 mb-8">
          <button onClick={() => handleAction(finishAction)} disabled={pending !== null || completeBusy}
            className="w-full text-white font-bold text-xl py-5 rounded-2xl bg-green-600 active:bg-green-700 transition-colors disabled:opacity-40">
            {completeBusy ? 'Finishing…' : 'Finish Job'}
          </button>
        </div>
      )}

      {order.status === 'ready' && (
        <div className="px-6 mb-8">
          <p className="text-green-400 text-center font-semibold py-3">✓ Finished — Ready for pickup</p>
        </div>
      )}
      {(order.status === 'delivered' || order.status === 'cancelled') && (
        <div className="px-6 mb-8">
          <p className="text-gray-600 text-center text-base py-4">
            {order.status === 'delivered' ? 'Vehicle has been delivered.' : 'Job was cancelled.'}
          </p>
        </div>
      )}

      {/* ── Manager controls (detailed) — hidden from employees, backend untouched ── */}
      {isManager && (
        <div className="px-6 mt-2 mb-8 border-t border-gray-900 pt-5">
          <h2 className="text-gray-600 text-xs font-semibold uppercase tracking-widest mb-3">Manager controls</h2>

          {/* precise status + focus + tech + timer + SO number */}
          <div className="text-xs text-gray-500 flex flex-wrap items-center gap-x-3 gap-y-1 mb-4">
            <span className={statusCfg.color}>{statusCfg.label}</span>
            {order.serviceFocus && <span className="bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">{FOCUS_LABELS[order.serviceFocus] ?? order.serviceFocus}</span>}
            {activeTech && <span>{activeTech} working</span>}
            {order.arrivedAt && <span className="text-gray-600"><ElapsedTime from={order.arrivedAt} /> on lot</span>}
            <span className="text-gray-700 ml-auto">{order.orderNumber}</span>
          </div>

          {/* granular status actions (Start Work, Pause, QC, Deliver, …) */}
          {actions.length > 0 && (
            <div className="space-y-2 mb-4">
              {actions.map(action => (
                <button key={action.newStatus} onClick={() => handleAction(action)} disabled={pending !== null}
                  className={`w-full text-white font-semibold text-base py-3.5 rounded-2xl active:opacity-80 disabled:opacity-40 ${action.style}`}>
                  {pending === action.newStatus ? 'Updating…' : action.label}
                </button>
              ))}
            </div>
          )}

          {/* Invoice Draft — clean billing summary from the estimate (no QuickBooks) */}
          <button onClick={() => setShowInvoice(true)}
            className="w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-indigo-600 active:opacity-80 mb-4">
            Invoice Draft
          </button>

          {/* reopen a Ready Job that wasn't truly finished (reason + PIN) */}
          {order.status === 'ready' && (
            <button onClick={() => { setReopenMsg(null); setReopening(true) }}
              className="w-full text-amber-300 font-semibold text-sm py-3 rounded-2xl border border-amber-800/60 bg-amber-950/30 active:opacity-80 mb-4">
              Reopen Job
            </button>
          )}

          {/* optional Estimate layer (pricing + approval) */}
          {identity.estimateEnabled && (
            <a href={`/orders/${order.id}/estimate`} className="inline-block text-blue-400 text-sm font-semibold active:opacity-70 mb-4">Build / Edit Estimate →</a>
          )}

          {/* activity / audit timeline */}
          {order.recentEvents.length > 0 && (
            <div className="mt-2">
              <h3 className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-3">Activity</h3>
              <div className="space-y-2">
                {order.recentEvents.map((event: ServiceOrderEvent) => (
                  <div key={event.id} className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-gray-700 mt-2 shrink-0" />
                    <div>
                      <p className="text-gray-300 text-sm">
                        {event.eventType === 'reopened'
                          ? `Reopened${event.employeeName ? ' by ' + event.employeeName : ''}${reopenReason(event.note)}`
                          : event.eventType === 'completed'
                            ? `Completed (Ready)${event.employeeName ? ' · ' + event.employeeName : ''}`
                            : event.eventType === 'service_added'
                              ? `Service added: ${event.note ?? ''}${event.employeeName ? ` · ${event.employeeName}` : ''}`
                              : event.newStatus
                                ? `${event.employeeName ? event.employeeName + ' — ' : ''}${STATUS_CONFIG[event.newStatus]?.label ?? event.newStatus}`
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

      {/* Completion checklist */}
      {completing && (
        <CompletionModal
          services={services}
          qcRequired={order.qcRequired}
          busy={completeBusy}
          error={completeMsg}
          onConfirm={completeJob}
          onCancel={() => setCompleting(false)}
          initialAck={acked}
        />
      )}

      {/* Reopen (reason + PIN) */}
      {reopening && (
        <ReopenModal busy={reopenBusy} error={reopenMsg} onConfirm={submitReopen} onCancel={() => setReopening(false)} />
      )}

      {/* Invoice Draft (manager/admin) */}
      {showInvoice && (
        <InvoiceDraftModal orderId={order.id} onClose={() => setShowInvoice(false)} />
      )}

      {/* Edit Vehicle (manager correction) */}
      {editingVehicle && (
        <VehicleEditModal
          orderId={order.id}
          onClose={() => setEditingVehicle(false)}
          onSaved={async (msg) => { setEditingVehicle(false); setVehToast(msg); await reload(); setTimeout(() => setVehToast(null), 6000) }}
        />
      )}

    </main>
  )
}
