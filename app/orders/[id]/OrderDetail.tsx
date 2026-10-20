'use client'

import { useState, useCallback, useEffect, useRef, useId } from 'react'
import { useRouter } from 'next/navigation'
import type { OrderWithContext, ServiceOrderEvent } from '@/apps/workflow/db'
import { useIdentity } from '@/app/components/IdentityBar'
import NavHeader from '@/app/components/NavHeader'
import CustomerContactModal from '@/app/components/CustomerContactModal'
import SwipeRow from '@/app/components/SwipeRow'
import { useVinDecode, type VinDecodeResult } from '@/app/hooks/useVinDecode'
import { isDealerOrder, orderSourceKind } from '@/apps/workflow/fees'
import type { MovePreview } from '@/apps/estimates/move-to-estimates'
import PartsSection from './PartsSection'
import { countJobParts } from '@/apps/parts/status'
import DealerInvoicePanel from './DealerInvoicePanel'
import OrderPhotos from '@/app/components/OrderPhotos'
import PhotoInput from '@/app/components/PhotoInput'
import { interpretVinScan } from './vin-scan'
import { useJobItems } from './JobItems'
import { PartRow, ServiceRow, Row } from './estimate/ItemRows'
import { InvoiceDraftModal, money, SEND_BLOCK_MSG, SYNC_BLOCK_MSG, type InvoiceDraftData, type QbCandidate } from './InvoiceDraftPanel'
import { InvoicePaymentSection } from './InvoicePaymentSection'
import { PAYMENT_LOCKS_INVOICE } from '@/apps/quickbooks/retail-payment'

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

// ── Finish Job — ONE confirmation ("All work is complete and this vehicle is ready.") ──
// The server (validateCompletion) enforces the same rule: work must be listed, the confirmation must be
// given, and — only when the Job requires QC — a separate, explicit QC pass. Never pre-checked.

type CompletionConfirm = { allWorkComplete: boolean; qcPassed?: boolean }

function CompletionModal({ services, qcRequired, busy, error, onConfirm, onCancel }: {
  services: string[]
  qcRequired: boolean
  busy: boolean
  error: string | null
  onConfirm: (p: CompletionConfirm) => void
  onCancel: () => void
}) {
  const [confirmed, setConfirmed] = useState(false)
  const [qcPassed, setQcPassed] = useState(false)
  const noServices = services.length === 0
  const ready = !noServices && confirmed && (!qcRequired || qcPassed)

  const Check = ({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) => (
    <button type="button" role="checkbox" aria-checked={on} onClick={() => set(!on)}
      className={`w-full flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left ${on ? 'bg-green-600/15 border-green-600' : 'bg-gray-800 border-gray-700'}`}>
      <span aria-hidden className={`w-6 h-6 rounded-md flex items-center justify-center text-sm shrink-0 ${on ? 'bg-green-600 text-white' : 'border border-gray-600 text-transparent'}`}>✓</span>
      <span className="text-white text-base">{label}</span>
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div role="dialog" aria-modal="true" aria-labelledby="finish-job-title" className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[90vh] overflow-y-auto">
        <h2 id="finish-job-title" className="text-white font-bold text-xl">Finish Job</h2>

        {noServices ? (
          <div className="mt-4 rounded-2xl bg-amber-950/40 border border-amber-700/50 px-4 py-4">
            <p className="text-amber-300 font-medium text-sm">No services are listed on this Job.</p>
            <p className="text-amber-400/80 text-xs mt-1">Add the work performed with <b>＋ Add Service</b> before finishing it.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            <Check on={confirmed} set={setConfirmed} label="All work is complete and this vehicle is ready." />
            {qcRequired && <Check on={qcPassed} set={setQcPassed} label="QC passed (required for this Job)" />}
          </div>
        )}

        {error && <p role="alert" className="text-amber-400 text-sm mt-3">{error}</p>}
        <div className="mt-5 flex gap-3">
          <button type="button" onClick={onCancel} disabled={busy}
            className="flex-1 h-14 rounded-2xl border border-gray-700 text-gray-300 text-base font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => onConfirm(qcRequired ? { allWorkComplete: confirmed, qcPassed } : { allWorkComplete: confirmed })} disabled={!ready || busy}
            className="flex-[2] h-14 rounded-2xl bg-green-600 active:bg-green-700 text-white text-lg font-bold disabled:opacity-40">
            {busy ? 'Finishing…' : 'Confirm — Finish Job'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ReopenModal({ busy, error, onConfirm, onCancel }: {
  busy: boolean; error: string | null
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10">
        <div className="flex items-center justify-between mb-1"><h2 className="text-white font-bold text-xl">Reopen this Job</h2><button onClick={onCancel} className="text-gray-500 text-sm">Cancel</button></div>
        <p className="text-gray-500 text-xs mb-4">This clears the completion (it will count only when finished again). The original completion is kept in history.</p>
        <p className="text-gray-500 text-xs uppercase tracking-widest mb-1">Reason</p>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being reopened?" rows={2}
          className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-base" />
        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
        <button onClick={() => onConfirm(reason)} disabled={busy || !reason.trim()}
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
function VehField({ label, value, onChange, numeric = false, upper = false, action }: {
  label: string
  value: string
  onChange: (v: string) => void
  numeric?: boolean
  upper?: boolean
  /** Optional control beside the label (wraps above the field on narrow screens). */
  action?: React.ReactNode
}) {
  const id = useId()
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <label htmlFor={id} className="text-gray-500 text-xs uppercase tracking-widest">{label}</label>
        {action}
      </div>
      <input
        id={id}
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
  const [form, setForm] = useState({ year: '', make: '', model: '', color: '', vin: '', stockNumber: '' })
  const [ctx, setCtx] = useState({ isDealer: false, qbLinked: false })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { status: vinStatus, decodeDebounced, sanitize } = useVinDecode()
  const [vinMsg, setVinMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [pending, setPending] = useState<{ year: string; make: string; model: string } | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanCandidate, setScanCandidate] = useState<{ vin: string; message: string } | null>(null)   // Scan VIN
  const formRef = useRef(form); formRef.current = form

  // Decode-on-edit: when the corrected VIN reaches 17 valid chars, decode + populate.
  // Blank Y/M/M → auto-fill; existing but different → confirm; invalid/failed → warn only.
  const handleDecode = useCallback((r: VinDecodeResult) => {
    const cur = formRef.current
    if (!r.valid) { setVinMsg({ tone: 'warn', text: r.error || 'This VIN could not be validated — check it or enter details manually.' }); return }
    if (!r.ok) { setVinMsg({ tone: 'warn', text: r.error || "Valid VIN, but vehicle details couldn't be decoded — enter them manually." }); return }
    const dec = { year: r.year || '', make: r.make || '', model: r.model || '' }
    const label = [dec.year, dec.make, dec.model].filter(Boolean).join(' ')
    const allBlank = !cur.year.trim() && !cur.make.trim() && !cur.model.trim()
    const same = cur.year.trim() === dec.year && cur.make.trim() === dec.make && cur.model.trim() === dec.model
    if (allBlank) { setForm((f) => ({ ...f, year: dec.year || f.year, make: dec.make || f.make, model: dec.model || f.model })); setVinMsg({ tone: 'ok', text: `VIN ✓ ${label}` }) }
    else if (!same) { setPending(dec); setVinMsg(null) }
    else setVinMsg({ tone: 'ok', text: `VIN ✓ ${label}` })
  }, [])

  const onVinChange = useCallback((raw: string) => {
    const vin = sanitize(raw)
    setForm((f) => ({ ...f, vin })); setVinMsg(null); setPending(null); setScanCandidate(null)
    decodeDebounced(vin, handleDecode)
  }, [sanitize, decodeDebounced, handleDecode])

  // Scan VIN: photo/upload → the existing VIN reader (read + validate + canonical decode). Only a VIN
  // that passes validation is put in the field; a failing read is offered for review and never
  // replaces the VIN on file. Nothing is saved until "Save correction".
  const onVinPhoto = useCallback(async (file: File) => {
    setScanning(true); setVinMsg(null); setPending(null); setScanCandidate(null)
    try {
      const fd = new FormData(); fd.append('vinImage', file, file.name)
      const res = await fetch('/api/estimator/vin', { method: 'POST', body: fd })
      const out = interpretVinScan(res.ok, await res.json().catch(() => null))
      if (out.kind === 'decoded') { setForm((f) => ({ ...f, vin: out.vin })); handleDecode(out.decode) }
      else if (out.kind === 'review') setScanCandidate({ vin: out.candidate, message: out.message })
      else setVinMsg({ tone: 'warn', text: out.message })
    } catch { setVinMsg({ tone: 'warn', text: 'Network error reading the photo — try again or type the VIN.' }) }
    finally { setScanning(false) }
  }, [handleDecode])

  useEffect(() => {
    fetch(`/api/workflow/orders/${orderId}/vehicle`)
      .then((r) => r.json())
      .then((d) => {
        setForm({ year: d.year ?? '', make: d.make ?? '', model: d.model ?? '', color: d.color ?? '', vin: d.vin ?? '', stockNumber: d.stockNumber ?? '' })
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
        : d.qb?.action === 'retail_sync_needed' ? 'Vehicle updated · QuickBooks sync needed'
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
            {/* Color — RETAIL only (optional; helps tell apart same Y/M/M vehicles). VIN decode
                never fills/overwrites it — the manager enters it manually. Dealer color comes
                from the tag/scan and is not editable here. */}
            {!ctx.isDealer && <VehField label="Color" value={form.color} onChange={(v) => setForm((f) => ({ ...f, color: v }))} />}
            <div>
              <VehField label="VIN" value={form.vin} onChange={onVinChange} upper
                action={<PhotoInput immediate cameraOnly compact cameraLabel="Scan VIN" onCapture={(f) => { void onVinPhoto(f) }} busy={scanning || busy} />} />
              <PhotoInput immediate uploadOnly asLink uploadLabel="Upload a VIN photo" className="mt-2" onCapture={(f) => { void onVinPhoto(f) }} busy={scanning || busy} />
            </div>
            {scanning && <p className="text-gray-500 text-xs">Reading VIN…</p>}
            {scanCandidate && (
              <div className="rounded-xl bg-amber-950/30 border border-amber-800/70 p-3">
                <p className="text-amber-300 text-xs uppercase tracking-widest">VIN read — needs a check</p>
                <p className="text-white font-mono text-base break-all mt-0.5">{scanCandidate.vin}</p>
                <p className="text-amber-200/80 text-xs mt-1">{scanCandidate.message}</p>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => onVinChange(scanCandidate.vin)}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold active:opacity-80">Put in VIN field to correct</button>
                  <button onClick={() => setScanCandidate(null)}
                    className="flex-1 py-2.5 rounded-xl border border-gray-700 text-gray-300 text-sm font-semibold active:opacity-70">Keep current VIN</button>
                </div>
              </div>
            )}
            {vinStatus === 'decoding' && <p className="text-gray-500 text-xs">Decoding VIN…</p>}
            {vinMsg && <p className={`text-xs ${vinMsg.tone === 'ok' ? 'text-green-400' : 'text-amber-400'}`}>{vinMsg.text}</p>}

            {/* VIN decoded to different Y/M/M than what's on file → confirm before overwrite */}
            {pending && (
              <div className="rounded-xl bg-gray-800/60 border border-gray-700 p-3">
                <p className="text-gray-500 text-xs uppercase tracking-widest">VIN decoded as</p>
                <p className="text-white font-semibold">{[pending.year, pending.make, pending.model].filter(Boolean).join(' ') || '—'}</p>
                <p className="text-gray-500 text-xs uppercase tracking-widest mt-2">Current vehicle</p>
                <p className="text-white font-semibold">{[form.year, form.make, form.model].filter(Boolean).join(' ') || '—'}</p>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => { setForm((f) => ({ ...f, year: pending.year || f.year, make: pending.make || f.make, model: pending.model || f.model })); setVinMsg({ tone: 'ok', text: 'Using decoded vehicle info' }); setPending(null) }}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold active:opacity-80">Use decoded vehicle info</button>
                  <button onClick={() => { setPending(null); setVinMsg({ tone: 'ok', text: 'Kept current info' }) }}
                    className="flex-1 py-2.5 rounded-xl border border-gray-700 text-gray-300 text-sm font-semibold active:opacity-70">Keep current info</button>
                </div>
              </div>
            )}

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
// ── Edit Customer (manager correction of name/phone/email) ────────────────────
function CustomerEditModal({ orderId, onClose, onSaved }: { orderId: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '' })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/workflow/orders/${orderId}/contact`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setForm({ name: d.customer ?? '', phone: d.phone ?? '', email: d.email ?? '' }) })
      .catch(() => setErr('Could not load customer info.'))
      .finally(() => setLoading(false))
  }, [orderId])

  const save = async () => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/customer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setErr(d.error ?? 'Could not save.'); return }
      onSaved(d.changed?.length ? (d.qbSyncNeeded ? 'Customer updated · QuickBooks sync needed' : 'Customer updated') : 'No changes made')
    } catch { setErr('Network error — try again.') } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-xl">Edit Customer</h2>
          <button onClick={onClose} className="text-gray-500 text-sm">Cancel</button>
        </div>
        {loading ? (
          <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" /></div>
        ) : (
          <div className="space-y-4">
            <VehField label="Name" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
            <VehField label="Phone" value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />
            <VehField label="Email" value={form.email} onChange={(v) => setForm((f) => ({ ...f, email: v }))} />
            {err && <p className="text-amber-400 text-sm">{err}</p>}
            <button onClick={save} disabled={busy}
              className="w-full h-14 rounded-2xl bg-green-600 active:bg-green-700 text-white text-lg font-bold disabled:opacity-40">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Third-party billing (manager) — "Different person/company paying?" ────────
// Occasional: a company/payer who is NOT the vehicle owner covers this one job. Sets who the QB
// invoice is billed to + sent to, for THIS order only. Never changes the vehicle owner or history.
function ContactRow({ label, value, onAdd }: { label: string; value: string | null; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-800">
      <div className="min-w-0">
        <p className="text-gray-500 text-xs uppercase tracking-widest">{label}</p>
        {value ? <p className="text-white text-sm mt-0.5 truncate">{value}</p>
               : <p className="text-amber-400 text-sm mt-0.5">Missing</p>}
      </div>
      {!value && (
        <button onClick={onAdd}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg text-blue-400 border border-blue-900/60 active:opacity-70 shrink-0">Add</button>
      )}
    </div>
  )
}


// ── Post-Finish Completion Summary / billing handoff (Phase A + B) ────────────
// Appears AFTER completion has already committed (the Job is Ready and counted in Daily
// Production). Shows the authoritative total (Invoice Draft read model), customer contact,
// and invoice state. Phase B: manager/admin can CREATE the retail QuickBooks invoice from
// here via the EXISTING create-qb endpoint (idempotent; no new writer). NO Send (Phase D)
// and NO Sync (Phase C). Rendered only for manager/admin on retail Jobs (the parent guards
// this). "Done" always returns to the Work Board; nothing here can undo completion — Create
// is never required to finish a Job and its failure never blocks Done.
function CompletionSummary({ orderId, customerName, vehicleName, onDone }: {
  orderId: string; customerName: string; vehicleName: string; onDone: () => void
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<InvoiceDraftData | null>(null)
  const [qbEnabled, setQbEnabled] = useState(false)
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [contact, setContact] = useState<{ phone: string | null; email: string | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showInvoice, setShowInvoice] = useState(false)
  const [editingContact, setEditingContact] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncErr, setSyncErr] = useState<string | null>(null)
  const [confirmSentOpen, setConfirmSentOpen] = useState(false)  // sync an already-sent invoice
  const [sendEnabled, setSendEnabled] = useState(false)
  const [paymentEnabled, setPaymentEnabled] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendErr, setSendErr] = useState<string | null>(null)
  const [sendPreview, setSendPreview] = useState<{ recipient: string | null; totalCents: number; invoiceNumber: string | null; resend: boolean } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Ambiguous QB customer: the colliding candidates to choose from (null = picker closed).
  const [custCandidates, setCustCandidates] = useState<QbCandidate[] | null>(null)
  const [savingCust, setSavingCust] = useState(false)
  // Stable per-mount requestId (generated once on first Create) so double-taps / browser
  // retries dedupe on the server.
  const createReqId = useRef<string | null>(null)

  const loadContact = useCallback(async () => {
    const r = await fetch(`/api/workflow/orders/${orderId}/contact`, { cache: 'no-store' })
    const d = await r.json().catch(() => null)
    if (d?.ok) setContact({ phone: d.phone ?? null, email: d.email ?? null })
  }, [orderId])

  const loadDraft = useCallback(async () => {
    const r = await fetch(`/api/workflow/orders/${orderId}/invoice`, { cache: 'no-store' })
    const d = await r.json().catch(() => null)
    if (d?.draft) { setDraft(d.draft); setQbEnabled(!!d.qbEnabled); setSyncEnabled(!!d.qbSyncEnabled); setSendEnabled(!!d.qbSendEnabled); setPaymentEnabled(!!d.qbPaymentEnabled) }
  }, [orderId])

  useEffect(() => {
    let ok = true
    Promise.all([
      fetch(`/api/workflow/orders/${orderId}/invoice`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch(`/api/workflow/orders/${orderId}/contact`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
    ]).then(([inv, con]) => {
      if (!ok) return
      if (inv?.draft) { setDraft(inv.draft); setQbEnabled(!!inv.qbEnabled); setSyncEnabled(!!inv.qbSyncEnabled); setSendEnabled(!!inv.qbSendEnabled); setPaymentEnabled(!!inv.qbPaymentEnabled) }
      if (con?.ok) setContact({ phone: con.phone ?? null, email: con.email ?? null })
    }).finally(() => { if (ok) setLoading(false) })
    return () => { ok = false }
  }, [orderId])

  // Send / Resend: read-only preview (server resolves recipient + identity + total + not-stale)
  // → confirm sheet → confirmed send. resend=true is the only path that re-emails a sent invoice.
  const openSend = useCallback(async (resend = false) => {
    if (sending) return
    setSendErr(null); setSending(true)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/send-qb`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: false }),
      })
      const d = await res.json()
      const p = d.preview
      if (!p || !p.ok) { setSendErr(p?.error ?? SEND_BLOCK_MSG[p?.block ?? ''] ?? 'Cannot send this invoice.'); await loadDraft(); return }
      setSendPreview({ recipient: p.recipient ?? null, totalCents: p.draftTotalCents ?? 0, invoiceNumber: p.invoiceNumber ?? null, resend })
    } catch { setSendErr('Network error — please try again.') }
    finally { setSending(false) }
  }, [orderId, sending, loadDraft])

  const confirmSend = useCallback(async () => {
    if (!sendPreview || sending) return
    const resend = sendPreview.resend
    setSending(true); setSendErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/send-qb`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, resend }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) { setSendErr(d.error ?? SEND_BLOCK_MSG[d.block ?? ''] ?? 'Send failed.') }
      else { setToast(resend ? 'Invoice resent' : (d.reconciled ? 'Invoice was already sent' : 'Invoice sent')); setTimeout(() => setToast(null), 5000) }
      setSendPreview(null); await loadDraft()
    } catch { setSendErr('Network error — please try again.') }
    finally { setSending(false) }
  }, [orderId, sendPreview, sending, loadDraft])

  // Create the retail QuickBooks invoice via the EXISTING idempotent endpoint. Never a second
  // writer; all duplicate/total protections live server-side. On failure the Job stays
  // completed, Done stays available, and Retry reuses the same request path (PSID adoption
  // recovers a QB-created/local-write-lost invoice).
  const createInvoice = useCallback(async () => {
    if (creating) return
    if (!createReqId.current) createReqId.current = `${orderId}-${Date.now()}`
    setCreating(true); setCreateErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/create-qb`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: createReqId.current }),
      })
      const d = await res.json().catch(() => ({}))
      // Ambiguous QB customer → open the picker instead of a dead-end error.
      if (d.status === 'ambiguous' && Array.isArray(d.candidates) && d.candidates.length) {
        setCustCandidates(d.candidates); setCreateErr(d.error ?? null)
      } else if (!res.ok || !d.ok) { setCreateErr(d.error ?? 'Could not create the QuickBooks invoice.') }
      else { setToast('QuickBooks invoice created'); setTimeout(() => setToast(null), 5000) }
      await loadDraft()
    } catch { setCreateErr('Network error — please try again.') }
    finally { setCreating(false) }
  }, [orderId, creating, loadDraft])

  // Persist the manager's chosen QB customer (directory cache), then re-run Create against it.
  const chooseCustomer = useCallback(async (qbCustomerId: string) => {
    if (savingCust) return
    setSavingCust(true); setCreateErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/customer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qbCustomerId }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) { setCreateErr(d.error ?? 'Could not save the QuickBooks customer.'); return }
      setCustCandidates(null)
      await createInvoice()
    } catch { setCreateErr('Network error — please try again.') }
    finally { setSavingCust(false) }
  }, [orderId, savingCust, createInvoice])

  // Sync (UPDATE) the EXISTING linked invoice via the idempotent sync endpoint. Never creates a
  // second invoice. An already-sent invoice returns confirm_required → we open a confirm sheet.
  const syncInvoice = useCallback(async (confirmSent = false) => {
    if (syncing) return
    setSyncing(true); setSyncErr(null)
    try {
      const res = await fetch(`/api/workflow/orders/${orderId}/invoice/sync-qb`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, confirmSent }),
      })
      const d = await res.json().catch(() => ({}))
      if (d.block === 'confirm_required') { setConfirmSentOpen(true) }
      else if (!res.ok || !d.ok) { setSyncErr(d.error ?? SYNC_BLOCK_MSG[d.block ?? ''] ?? 'Could not sync the invoice.') ; setConfirmSentOpen(false) }
      else { setToast(d.noop ? 'QuickBooks already up to date' : 'QuickBooks invoice updated'); setTimeout(() => setToast(null), 5000); setConfirmSentOpen(false) }
      await loadDraft()
    } catch { setSyncErr('Network error — please try again.') }
    finally { setSyncing(false) }
  }, [orderId, syncing, loadDraft])

  // Invoice state — INVOICE-ID-FIRST. Once a QB invoice is linked we never offer Create again;
  // the action is Sync / Retry Sync / (needs review). All flags come from the Invoice Draft.
  const qb = draft?.qb
  const priced = !!draft?.priced
  // Itemized breakdown started but not every service is priced → the total is a partial sum, not the
  // agreed amount. Treat like "needs pricing" for invoicing and surface the agreed reference.
  const pricingIncomplete = !!draft?.pricingIncomplete
  // Complete, but the itemized work total still differs from the agreed reference (manager hasn't
  // accepted it). Also blocks invoicing — the difference must be resolved in the Estimate first.
  const referenceUnreconciled = !pricingIncomplete && draft?.referenceCents != null
  const pricingUnfinalized = pricingIncomplete || referenceUnreconciled
  const linked = !!qb?.linked
  const isSent = !!qb?.sent
  const needsReview = !!qb?.needsReview
  const syncNeeded = !!qb?.syncNeeded
  const resendRecommended = !!qb?.resendRecommended
  const syncFailed = linked && qb?.status === 'error'
  // A recorded / in-flight / unconfirmed payment freezes the invoice (no Sync; Email Paid Invoice replaces Send).
  const payLocked = !!qb && PAYMENT_LOCKS_INVOICE.includes(qb.payment.status)
  // "current" = linked, not stale, not in review/error → the state where Send is allowed.
  const current = linked && !syncNeeded && !needsReview && !syncFailed && !payLocked
  const canSend = current && !isSent && sendEnabled
  const canResend = current && isSent && sendEnabled

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60">
      <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[92vh] overflow-y-auto">
        {/* Finished banner — completion is ALREADY committed before this screen opens */}
        <div className="text-center mb-5">
          <div className="w-14 h-14 rounded-full bg-green-600/20 border border-green-700 flex items-center justify-center mx-auto mb-3">
            <span className="text-green-400 text-2xl">✓</span>
          </div>
          <h2 className="text-white font-bold text-xl">Job finished</h2>
          <p className="text-green-400 text-sm mt-0.5">Ready for pickup</p>
        </div>

        {loading ? (
          <p className="text-gray-500 text-sm py-8 text-center">Loading…</p>
        ) : (
          <>
            {/* Who / what */}
            <div className="mb-4">
              <p className="text-white text-base font-semibold">{draft?.customer || customerName}</p>
              <p className="text-gray-400 text-sm">{draft?.vehicle || vehicleName}</p>
            </div>

            {/* Total — authoritative Invoice Draft read model (no recalculation here). When itemized
                pricing is incomplete we DON'T present the partial sum as the total; we show the agreed
                amount as a reference and flag that pricing must be finished. */}
            {pricingIncomplete ? (
              <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-3.5 mb-4">
                <div className="flex items-center justify-between">
                  <p className="text-amber-300 font-semibold text-sm">Pricing incomplete</p>
                  {draft?.referenceCents != null && <span className="text-amber-100 font-bold tabular-nums">{money(draft.referenceCents)} <span className="text-amber-300/70 text-xs font-normal">agreed</span></span>}
                </div>
                <p className="text-amber-200/60 text-xs mt-1">Some services still need a price. Finish pricing before invoicing — the partial total isn’t the agreed amount.</p>
              </div>
            ) : referenceUnreconciled ? (
              <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-4 py-3.5 mb-4">
                <p className="text-amber-300 font-semibold text-sm">Itemized total differs from agreed</p>
                {/* pre-tax WORK prices — fees/tax are separate */}
                <div className="mt-1 flex items-center justify-between text-sm"><span className="text-amber-200/80">Agreed work price</span><span className="text-amber-100 tabular-nums">{money(draft!.referenceCents!)}</span></div>
                <div className="flex items-center justify-between text-sm"><span className="text-amber-200/80">Itemized work price</span><span className="text-amber-100 font-bold tabular-nums">{money(draft!.workPriceCents)}</span></div>
                <p className="text-amber-200/60 text-xs mt-1">Accept the itemized total in the Estimate before invoicing.</p>
              </div>
            ) : draft?.priced ? (
              <div className="flex items-center justify-between rounded-xl bg-gray-800/60 px-4 py-3.5 mb-4">
                <p className="text-white font-bold text-base">Total</p>
                <span className="text-white font-bold text-lg tabular-nums">{money(draft.totalCents)}</span>
              </div>
            ) : (
              <p className="text-gray-400 text-sm bg-gray-800/60 rounded-xl px-4 py-3.5 mb-4">
                No Work Price set yet — add pricing before this Job can be invoiced.
              </p>
            )}

            {/* Contact — reuses the existing customer edit path (updates in place, never
                creates a duplicate customer). Phone is informational until SMS ships. */}
            <div className="mb-4">
              <ContactRow label="Email" value={contact?.email ?? null} onAdd={() => setEditingContact(true)} />
              <ContactRow label="Phone" value={contact?.phone ?? null} onAdd={() => setEditingContact(true)} />
            </div>

            {/* Invoice — INVOICE-ID-FIRST. Linked → Sync/Review (never Create). Not linked →
                Create (or Edit Estimate when unpriced). All via existing idempotent endpoints. */}
            <div className="mb-6">
              <p className="text-gray-500 text-xs uppercase tracking-widest mb-1.5">Invoice</p>

              {linked ? (
                /* A QB invoice exists → show its number + state; the only write is Sync. */
                <>
                  {(() => {
                    const box = qb?.payment.status === 'paid' ? { tone: 'border-green-900/60 bg-green-950/30', head: 'text-green-300', label: 'Paid' }
                      : needsReview ? { tone: 'border-amber-900/60 bg-amber-950/30', head: 'text-amber-300', label: 'Needs review' }
                      : syncFailed ? { tone: 'border-amber-900/60 bg-amber-950/30', head: 'text-amber-300', label: 'Sync failed' }
                      : syncNeeded ? { tone: 'border-amber-900/60 bg-amber-950/30', head: 'text-amber-300', label: isSent ? 'Sent · Sync needed' : 'Sync needed' }
                      : resendRecommended ? { tone: 'border-amber-900/60 bg-amber-950/30', head: 'text-amber-300', label: 'Updated after last email · Resend recommended' }
                      : isSent ? { tone: 'border-green-900/60 bg-green-950/30', head: 'text-green-300', label: 'Sent' }
                      : { tone: 'border-green-900/60 bg-green-950/30', head: 'text-green-300', label: 'Current' }
                    return (
                      <div className={`rounded-xl border px-4 py-3 ${box.tone}`}>
                        <p className={`text-sm font-semibold ${box.head}`}>QuickBooks Invoice{qb?.invoiceNumber ? ` #${qb.invoiceNumber}` : ''}</p>
                        <p className="text-gray-400 text-xs mt-0.5">{box.label}</p>
                        {isSent && contact?.email && !resendRecommended && !syncNeeded && <p className="text-gray-400 text-xs mt-0.5">{contact.email}</p>}
                        {needsReview && qb?.error && <p className="text-amber-400/80 text-xs mt-1">{qb.error}</p>}
                      </div>
                    )
                  })()}
                  <button onClick={() => setShowInvoice(true)}
                    className="mt-3 w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-indigo-600 active:opacity-80">
                    Review Invoice
                  </button>
                  {/* Sync offered only when stale/failed and not a review-blocked state. */}
                  {(syncNeeded || syncFailed) && !needsReview && syncEnabled && !payLocked && (
                    <button onClick={() => syncInvoice(false)} disabled={syncing}
                      className="mt-3 w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
                      {syncing ? 'Syncing…' : syncFailed ? 'Retry Sync' : 'Sync QuickBooks'}
                    </button>
                  )}
                  {syncErr && <p className="text-amber-400 text-sm mt-2">{syncErr}</p>}
                  {/* Send — current + unsent. Blocked while stale/needs-review (no button shown). */}
                  {canSend && (
                    <button onClick={() => openSend(false)} disabled={sending}
                      className="mt-3 w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
                      {sending ? 'Preparing…' : 'Send Invoice'}
                    </button>
                  )}
                  {/* Resend — explicit secondary action once already sent (confirmation required). */}
                  {canResend && (
                    <button onClick={() => openSend(true)} disabled={sending}
                      className={`mt-3 w-full font-semibold text-base py-3.5 rounded-2xl active:opacity-80 disabled:opacity-50 ${resendRecommended ? 'bg-amber-600 text-white' : 'border border-gray-700 text-gray-300'}`}>
                      {sending ? 'Preparing…' : 'Resend Invoice'}
                    </button>
                  )}
                  {sendErr && <p className="text-amber-400 text-sm mt-2">{sendErr}</p>}
                  {/* Record Payment → Paid → Email / Print Paid Invoice. */}
                  {qb && (paymentEnabled || qb.payment.status !== 'none') && (
                    <InvoicePaymentSection orderId={orderId} qb={qb} paymentEnabled={paymentEnabled && !needsReview} sendEnabled={sendEnabled}
                      disabled={syncing || sending} onChanged={loadDraft} onToast={(m) => { setToast(m); setTimeout(() => setToast(null), 5000) }} />
                  )}
                </>
              ) : !priced || pricingUnfinalized ? (
                /* Not linked + unpriced OR partial itemized pricing OR itemized total not yet
                   reconciled with the agreed amount → never create a $0/partial/unagreed invoice;
                   send the manager back to resolve it in the Estimate. */
                <>
                  <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 text-amber-300 px-4 py-3 text-sm">{pricingIncomplete ? 'Finish pricing every service before invoicing' : referenceUnreconciled ? 'Accept the itemized total (differs from agreed) before invoicing' : 'Invoice needs pricing'}</div>
                  <button onClick={() => router.push(`/orders/${orderId}/estimate`)}
                    className="mt-3 w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-indigo-600 active:opacity-80">
                    View / Edit Invoice
                  </button>
                </>
              ) : (
                /* Not linked + priced → Review + Create (Phase B). */
                <>
                  <div className="rounded-xl border border-gray-800 bg-gray-800/40 text-gray-400 px-4 py-3 text-sm">Not created</div>
                  <button onClick={() => setShowInvoice(true)}
                    className="mt-3 w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-indigo-600 active:opacity-80">
                    Review Invoice
                  </button>
                  {qbEnabled ? (
                    <button onClick={createInvoice} disabled={creating}
                      className="mt-3 w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
                      {creating ? 'Creating…' : 'Create QuickBooks Invoice'}
                    </button>
                  ) : (
                    <p className="text-gray-600 text-xs mt-3">QuickBooks invoicing is turned off.</p>
                  )}
                  {createErr && <p className="text-amber-400 text-sm mt-2">{createErr}</p>}
                </>
              )}
            </div>

            {toast && <p className="text-green-400 text-sm mb-3">{toast}</p>}

            <button onClick={onDone}
              className="w-full text-white font-bold text-lg py-4 rounded-2xl bg-gray-700 active:bg-gray-600">
              Done
            </button>
          </>
        )}
      </div>

      {/* Pre-send confirmation (customer-facing email). Deliberate second tap; server re-checks. */}
      {sendPreview && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={() => !sending && setSendPreview(null)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-bold text-lg mb-3">{sendPreview.resend ? 'Resend' : 'Send'} QuickBooks Invoice{sendPreview.invoiceNumber ? ` #${sendPreview.invoiceNumber}` : ''}</h3>
            <p className="text-gray-400 text-sm">Customer</p>
            <p className="text-white text-base font-semibold mb-2">{draft?.customer || customerName}</p>
            <p className="text-gray-400 text-sm">To</p>
            <p className="text-white text-base font-semibold mb-2">{sendPreview.recipient}</p>
            <p className="text-gray-400 text-sm">Total</p>
            <p className="text-white text-2xl font-bold tabular-nums mb-5">{money(sendPreview.totalCents)}</p>
            <div className="flex gap-3">
              <button onClick={() => setSendPreview(null)} disabled={sending} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
              <button onClick={confirmSend} disabled={sending} className="flex-1 py-3.5 rounded-2xl bg-emerald-600 text-white font-bold active:opacity-80 disabled:opacity-50">{sending ? 'Sending…' : (sendPreview.resend ? 'Resend Invoice' : 'Send Invoice')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Sync an already-sent invoice — explicit confirm (never resends; Send stays OFF). */}
      {confirmSentOpen && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={() => !syncing && setConfirmSentOpen(false)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-bold text-lg mb-2">Update a sent invoice?</h3>
            <p className="text-gray-400 text-sm mb-5">
              This invoice was already emailed to the customer. Syncing will change the invoice in QuickBooks; it will <b>not</b> resend it, so the customer may hold an older copy.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmSentOpen(false)} disabled={syncing} className="flex-1 py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
              <button onClick={() => syncInvoice(true)} disabled={syncing} className="flex-1 py-3.5 rounded-2xl bg-amber-600 text-white font-bold active:opacity-80 disabled:opacity-50">{syncing ? 'Syncing…' : 'Sync anyway'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Ambiguous QB customer — manager chooses the right existing customer; saved for next time. */}
      {custCandidates && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70" onClick={() => !savingCust && setCustCandidates(null)}>
          <div className="bg-gray-900 rounded-t-3xl px-6 pt-6 pb-10 max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-bold text-lg mb-1">Choose the QuickBooks customer</h3>
            <p className="text-gray-400 text-sm mb-1">
              {customerName ? <>“{customerName}” matches </> : 'This customer matches '}
              more than one QuickBooks customer, so we won’t guess. Pick the right one — we’ll use it for this invoice and remember it next time.
            </p>
            <p className="text-amber-300/80 text-xs mb-4">Not sure? Check the email, phone, and past invoices in QuickBooks before choosing.</p>
            <div className="space-y-2.5">
              {custCandidates.map((c) => (
                <button key={c.id} onClick={() => chooseCustomer(c.id)} disabled={savingCust}
                  className="w-full text-left rounded-2xl border border-gray-700 bg-gray-800/40 px-4 py-3 active:opacity-70 disabled:opacity-40">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-white font-semibold text-base">{c.displayName || '(no name)'}</span>
                    <span className="text-gray-500 text-xs tabular-nums">QB #{c.id}{c.active === false ? ' · inactive' : ''}</span>
                  </div>
                  {c.email && <div className="text-gray-400 text-sm mt-0.5">{c.email}</div>}
                  {c.phone && <div className="text-gray-400 text-sm">{c.phone}</div>}
                </button>
              ))}
            </div>
            <button onClick={() => setCustCandidates(null)} disabled={savingCust}
              className="mt-5 w-full py-3.5 rounded-2xl border border-gray-700 text-gray-300 font-semibold active:opacity-70 disabled:opacity-40">
              {savingCust ? 'Saving…' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {showInvoice && <InvoiceDraftModal orderId={orderId} onClose={() => { setShowInvoice(false); loadDraft() }} />}
      {editingContact && (
        <CustomerEditModal orderId={orderId} onClose={() => setEditingContact(false)}
          onSaved={async (msg) => { setEditingContact(false); setToast(msg); await loadContact(); setTimeout(() => setToast(null), 5000) }} />
      )}
    </div>
  )
}

// ── Production Date section (manager/admin) — Change/Reset the Daily Production day ──────
// Moves a completed Job to a chosen shop-calendar day via production_date_override; never
// touches completed_at, status, or QuickBooks. Retail + dealer. Self-hides when not completed.
function ProductionDateSection({ orderId, onChanged }: { orderId: string; onChanged: () => void }) {
  const [state, setState] = useState<{ completed: boolean; effective: string | null; override: string | null; completedDay: string | null; today: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetch(`/api/workflow/orders/${orderId}/production-date`, { cache: 'no-store' })
    const d = await r.json().catch(() => null)
    if (d?.ok) setState(d)
  }, [orderId])
  useEffect(() => { load() }, [load])

  const save = useCallback(async (date: string | null) => {
    if (busy) return
    setBusy(true); setErr(null); setMsg(null)
    try {
      const r = await fetch(`/api/workflow/orders/${orderId}/production-date`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) { setErr(d.error ?? 'Could not update the production date.'); return }
      setEditing(false); setMsg(date ? 'Production date updated' : 'Reset to completed date'); setTimeout(() => setMsg(null), 5000)
      await load(); onChanged()
    } catch { setErr('Network error — please try again.') } finally { setBusy(false) }
  }, [orderId, busy, load, onChanged])

  if (!state?.completed) return null
  const fmt = (d: string | null) => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—'
  return (
    <div className="mb-4">
      <h3 className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-2">Production date</h3>
      <div className="rounded-2xl bg-gray-900 border border-gray-800 px-4 py-3">
        <p className="text-white font-semibold">{fmt(state.effective)}</p>
        {state.override
          ? <p className="text-amber-400/80 text-xs mt-0.5">Overridden · completed {fmt(state.completedDay)}</p>
          : <p className="text-gray-600 text-xs mt-0.5">From completion time · completed_at unchanged</p>}
        {!editing ? (
          <div className="flex gap-4 mt-3">
            <button onClick={() => { setPick(state.effective ?? state.today); setEditing(true); setErr(null); setMsg(null) }} className="text-blue-400 text-sm font-semibold active:opacity-70">Change</button>
            {state.override && <button onClick={() => save(null)} disabled={busy} className="text-gray-400 text-sm font-semibold active:opacity-70 disabled:opacity-40">Reset to completed date</button>}
          </div>
        ) : (
          <div className="mt-3">
            <input type="date" value={pick} max={state.today} onChange={(e) => setPick(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-3 text-base" />
            {err && <p className="text-amber-400 text-sm mt-2">{err}</p>}
            <div className="flex gap-2 mt-3">
              <button onClick={() => { setEditing(false); setErr(null) }} disabled={busy} className="flex-1 py-2.5 rounded-xl border border-gray-700 text-gray-300 text-sm font-semibold active:opacity-70 disabled:opacity-40">Cancel</button>
              <button onClick={() => save(pick || null)} disabled={busy || !pick} className="flex-1 py-2.5 rounded-xl bg-green-600 text-white text-sm font-bold active:opacity-80 disabled:opacity-40">{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        )}
        {msg && <p className="text-green-400 text-sm mt-2">{msg}</p>}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function OrderDetail({ initialOrder, workValueCents = null }: { initialOrder: OrderWithContext; workValueCents?: number | null }) {
  const router = useRouter()

  const [order,       setOrder]       = useState<OrderWithContext>(initialOrder)
  // The expanded tracker's last server-confirmed parts list (null until it loads) — drives the live summary.
  const [liveParts,   setLiveParts]   = useState<ReadonlyArray<{ description: string; status: string }> | null>(null)
  const [urgentBusy,  setUrgentBusy]  = useState(false)
  const [pending,     setPending]     = useState<string | null>(null)
  const [picking,     setPicking]     = useState<ActionConfig | null>(null)
  const [error,       setError]       = useState<string | null>(null)
  const [addingService, setAddingService] = useState(false)  // picker open
  const [addBusy,     setAddBusy]     = useState(false)
  const [addError,    setAddError]    = useState<string | null>(null)
  const [completing,  setCompleting]  = useState(false)   // completion checklist open
  const [completeBusy, setCompleteBusy] = useState(false)
  const completeBusyRef = useRef(false)   // guards a double tap before the busy state re-renders
  const [completeMsg, setCompleteMsg] = useState<string | null>(null)
  const [reopening,   setReopening]   = useState(false)   // reopen (reason + PIN) open
  const [reopenBusy,  setReopenBusy]  = useState(false)
  const [reopenMsg,   setReopenMsg]   = useState<string | null>(null)
  const [editingVehicle, setEditingVehicle] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState(false)
  const [vehToast,    setVehToast]    = useState<string | null>(null)
  const [showInvoice, setShowInvoice] = useState(false)   // Invoice Draft (manager/admin)
  const [showContact, setShowContact] = useState(false)   // customer contact popup (all staff)
  const [summaryOpen, setSummaryOpen] = useState(false)   // Phase A: post-Finish billing handoff
  const [confirmMove, setConfirmMove] = useState(false)      // move-to-estimates confirm sheet
  const [moveBusy, setMoveBusy] = useState(false)
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null)
  const [movePreviewLoading, setMovePreviewLoading] = useState(false)
  const identity = useIdentity()
  const isManager = identity.effectiveRole === 'manager' || identity.effectiveRole === 'admin'

  // Open the Move-to-Estimates sheet and fetch the live preview (what will happen, or why it's blocked).
  const openMoveConfirm = useCallback(async () => {
    setError(null); setMovePreview(null); setMovePreviewLoading(true); setConfirmMove(true)
    try {
      const r = await fetch(`/api/workflow/orders/${order.id}/move-to-estimates`, { cache: 'no-store' })
      const d = await r.json().catch(() => null)
      if (r.ok && d?.ok && d.preview) setMovePreview(d.preview as MovePreview)
      else if (d?.error) setError(d.error)
    } catch { /* preview is best-effort; the POST re-checks and fails closed if needed */ }
    finally { setMovePreviewLoading(false) }
  }, [order.id])

  const { vehicle } = order
  const statusCfg   = STATUS_CONFIG[order.status] ?? { label: order.status, color: 'text-gray-400' }
  const actions     = STATUS_ACTIONS[order.status] ?? []
  const activeTech  = order.activeTechs[0]?.employeeName ?? null
  const vehicleName = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unknown Vehicle'
  const title       = order.customerName?.trim() || vehicleName || 'Unknown Customer'
  // Work vs parts, from the server's record-based split (fallback: the raw list, e.g. a stale client row).
  const services    = order.items?.services ?? order.services ?? []
  const partLabels  = order.items?.partLabels ?? []
  // One count rule (countJobParts) for this header and the Work Board card: live tracked parts + untracked
  // part labels; a cancelled part never counts. Live tracker list when loaded, else the server's figure.
  const partsSummary = liveParts ? countJobParts(partLabels, liveParts) : order.items?.parts ?? { total: 0, waiting: 0 }
  const partCount   = partsSummary.total
  const partsWaitingCount = partsSummary.waiting
  const activePartLabels = order.items?.activePartLabels ?? partLabels

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

  // Tap-to-edit Services / Parts (manager/admin, retail Job, estimate layer on): the same estimate
  // records, editors and save path as the Invoice page. A confirmed change refetches the Job (services/
  // parts split) and the server props (Total price). Employees and dealer Jobs keep the plain list.
  const itemsEditable = isManager && !isDealerOrder(order) && identity.estimateEnabled && order.status !== 'cancelled'
  const items = useJobItems({
    orderId: order.id, enabled: itemsEditable, vehicleLabel: vehicleName, customerLabel: title,
    onSaved: () => { void reload(); router.refresh() },
  })
  const itemsView = items.view?.exists ? items.view : null
  const refreshItems = items.refresh
  // The work to perform = the estimate's lines minus declined ones (same set as the Job's Services list).
  const activeServiceRows = itemsView ? itemsView.services.filter((sv) => !sv.declined) : []
  const mirrored = new Set(activeServiceRows.map((sv) => sv.title.trim().toLowerCase()))
  const unmirrored = itemsView ? services.filter((name) => !mirrored.has(name.trim().toLowerCase())) : []
  const editablePartIds = new Set((itemsView?.parts ?? []).map((p) => p.id))
  const partsKey = JSON.stringify(itemsView?.parts ?? [])

  // Parts tracker changes update the collapsed summary immediately; a change also refetches the Job so
  // the Services/Parts split follows. The <details> stays mounted, so its open/closed state is kept.
  const onPartsChange = useCallback((parts: ReadonlyArray<{ description: string; status: string }>, mutated: boolean) => {
    setLiveParts(parts)
    if (mutated) { void reload(); refreshItems() }
  }, [reload, refreshItems])

  // Mark / remove URGENT (any authenticated employee). Visual + Work Board priority only — never
  // changes status, price, production, or QuickBooks. Optimistic; reverts on failure.
  const toggleUrgent = useCallback(async () => {
    if (urgentBusy) return
    const next = !order.isUrgent
    setUrgentBusy(true); setError(null)
    setOrder((o) => ({ ...o, isUrgent: next }))
    try {
      const res = await fetch(`/api/workflow/orders/${order.id}/urgent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urgent: next }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setOrder((o) => ({ ...o, isUrgent: !next }))  // revert
      setError('Could not update urgency — try again.')
    } finally { setUrgentBusy(false) }
  }, [order.id, order.isUrgent, urgentBusy])

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
      refreshItems()                // the estimate mirrored the new service — show it as an editable row
    } catch { setAddError('Network error — try again.') } finally { setAddBusy(false) }
  }, [order.id, activeTech, reload, refreshItems])

  // Remove a service (manager/admin; swipe-left → Remove). Keeps services/estimate/pricing/
  // completion in sync server-side; retail-invoiced Jobs get flagged "QuickBooks sync needed".
  const removeService = useCallback(async (name: string) => {
    setError(null)
    try {
      const res = await fetch(`/api/workflow/orders/${order.id}/services`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: name }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) { setError(d.error ?? 'Could not remove the service.'); return }
      await reload(); refreshItems()
    } catch { setError('Network error — try again.') }
  }, [order.id, reload, refreshItems])

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
  const completeJob = useCallback(async (payload: CompletionConfirm) => {
    if (completeBusyRef.current) return   // one submit in flight (the server is idempotent too)
    completeBusyRef.current = true
    setCompleteBusy(true); setCompleteMsg(null)
    try {
      const res = await fetch(`/api/workflow/orders/${order.id}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus: 'ready', completion: payload }),
      })
      const d = await res.json()
      if (res.status === 422) {
        setCompleteMsg(d.reason === 'no_services' ? 'Add the work performed first.'
          : d.reason === 'qc_required' ? 'This Job requires QC — confirm QC passed.'
          : d.reason === 'confirmation_required' ? 'Confirm that all work is complete.'
          : (d.error ?? 'Could not finish the Job.'))
        return
      }
      if (!res.ok) { setCompleteMsg(d.error ?? 'Could not mark Ready.'); return }
      // Success: the Job is Ready (completed_at stamped, counted once in Daily Production).
      // Completion is now FINAL and independent of anything below. Phase A: for manager/admin
      // on a retail Job (flag on), open the Completion Summary / billing handoff instead of
      // redirecting; everyone else keeps the straight return to the Work Board. (Do NOT
      // setOrder the bare API row.)
      setCompleting(false)
      if (identity.completionInvoiceEnabled && isManager && !isDealerOrder(order)) {
        setSummaryOpen(true)
      } else {
        router.push('/work-board')
      }
    } catch { setCompleteMsg('Network error — try again.') } finally { completeBusyRef.current = false; setCompleteBusy(false) }
  }, [order, router, identity.completionInvoiceEnabled, isManager])

  // Manager correction: reopen a Ready Job (sensitive → reason; the signed manager session proves who).
  const submitReopen = useCallback(async (reason: string) => {
    setReopenBusy(true); setReopenMsg(null)
    try {
      const res = await fetch(`/api/workflow/orders/${order.id}/reopen`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
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
            {/* Retail customer name → tap for contact popup (call/email); dealer name is plain. */}
            {isDealerOrder(order) ? (
              <h1 className="text-white font-bold text-2xl leading-tight truncate">{title}</h1>
            ) : (
              <button onClick={() => setShowContact(true)}
                className="text-white font-bold text-2xl leading-tight truncate text-left underline decoration-dotted decoration-gray-600 underline-offset-4 active:opacity-70 max-w-full">
                {title}
              </button>
            )}
            <p className="text-gray-400 text-base mt-0.5">
              {vehicleName}{vehicle.color ? ` · ${vehicle.color}` : ''}
            </p>
            {isManager && (
              <div className="flex items-center gap-4 mt-1">
                <button onClick={() => setEditingVehicle(true)} className="text-blue-400 text-sm font-semibold active:opacity-70">Edit Vehicle</button>
                {!isDealerOrder(order) && <button onClick={() => setEditingCustomer(true)} className="text-blue-400 text-sm font-semibold active:opacity-70">Edit Customer</button>}
              </div>
            )}
          </div>
          <div className="flex-none flex flex-col items-end gap-1 mt-1">
            {order.isUrgent && <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/50">URGENT</span>}
            <span className={`font-bold text-base ${simpleStatus.color}`}>{simpleStatus.label}</span>
          </div>
        </div>

        {/* Urgent toggle (any authenticated employee) + retail TOTAL PRICE (view-only). */}
        <div className="flex items-center gap-3 mt-4">
          <button onClick={toggleUrgent} disabled={urgentBusy}
            className={`text-sm font-semibold px-3.5 py-2 rounded-xl border active:opacity-70 disabled:opacity-40 ${order.isUrgent ? 'border-amber-500 bg-amber-500/15 text-amber-300' : 'border-gray-700 text-gray-300'}`}>
            {order.isUrgent ? '★ Urgent — tap to remove' : 'Mark Urgent'}
          </button>
          {!isDealerOrder(order) && (
            <div className="ml-auto text-right">
              <p className="text-gray-500 text-[11px] uppercase tracking-widest">Total price</p>
              <p className={`font-bold tabular-nums ${workValueCents != null ? 'text-white text-lg' : 'text-gray-500 text-sm'}`}>
                {workValueCents != null ? money(workValueCents) : 'Not priced yet'}
              </p>
            </div>
          )}
        </div>
      </div>

      {vehToast && (
        <div className="mx-6 -mt-2 mb-4 bg-green-900/40 border border-green-700/50 rounded-xl px-4 py-3">
          <p className="text-green-300 text-sm font-medium">{vehToast}</p>
        </div>
      )}

      {/* Dealer invoice status + safe retry (manager/admin, dealer jobs). Lets a job
          that reached the board without an invoice (manual/board entry, or a queued
          check-in) be invoiced/retried idempotently — never a second job or line. */}
      {isManager && isDealerOrder(order) && <DealerInvoicePanel orderId={order.id} />}

      {/* Notes — genuine notes only (not the auto-generated Quick Entry summary) */}
      {showNotes && (
        <div className="px-6 mb-6">
          <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-2">Notes</h2>
          <p className="text-gray-300 text-sm whitespace-pre-wrap">{rawNotes}</p>
        </div>
      )}

      {/* Services — the work to perform (plain list; completion is confirmed once in Finish Job).
          Parts are listed separately below — classified by real part records, never by wording. */}
      <div className="px-6 mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Services</h2>
          <button onClick={() => { setAddError(null); setAddingService(true) }}
            className="text-blue-400 text-sm font-semibold active:opacity-70">+ Add Service</button>
        </div>
        {itemsView && (activeServiceRows.length + unmirrored.length) > 0 ? (
          // Editable rows (same look as the Invoice page): tap → the shared editor; swipe → Remove.
          <ul aria-label="Services" className="rounded-2xl border border-gray-800 bg-gray-900 divide-y divide-gray-800 overflow-hidden">
            {activeServiceRows.map((sv) => (
              <ServiceRow key={sv.id} s={sv} flat={itemsView.flat} readOnly={false} busy={items.busy}
                onOpen={() => items.openService(sv.id)} onRemove={() => items.removeService(sv.id)} />
            ))}
            {/* A Job service the estimate hasn't picked up yet: opening the Invoice page mirrors it. */}
            {unmirrored.map((name, i) => (
              <Row key={`u${i}`} id={`unmirrored:${i}`} label={`Edit ${name}`} title={name} sub="Open the invoice to price this line"
                price={<span className="text-amber-300 text-sm font-semibold">Add price</span>}
                onOpen={() => router.push(`/orders/${order.id}/estimate`)} onRemove={() => removeService(name)} />
            ))}
          </ul>
        ) : services.length > 0 ? (
          <ul className="rounded-2xl border border-gray-800 bg-gray-900 divide-y divide-gray-800 overflow-hidden">
            {services.map((s, i) => {
              const inner = <div className="px-4 py-3.5 text-white text-base min-w-0 break-words">{s}</div>
              // Manager/admin on a retail Job → swipe-left to remove. Employees & dealer Jobs see the plain list.
              // Opaque foreground so the red Remove underlay only shows while swiping, never at rest.
              return (isManager && !isDealerOrder(order))
                ? <li key={i}><SwipeRow onRemove={() => removeService(s)} contentClassName="bg-gray-900">{inner}</SwipeRow></li>
                : <li key={i}>{inner}</li>
            })}
          </ul>
        ) : (
          <p className="text-gray-600 text-sm italic">No services yet — tap ＋ Add Service.</p>
        )}
      </div>

      {/* Parts — collapsed by default with a count (and outstanding count where tracked). Expanded: the
          existing parts tracker (name, qty, part #, ordering/receiving status) for viewers it is rolled
          out to; otherwise the part names only. Same records as the estimate/invoice — nothing duplicated. */}
      {(partCount > 0 || identity.partsVisible) && (
        <details className="group px-6 mb-6">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">
              Parts{partCount > 0 && <span className="text-gray-400 normal-case"> · {partCount}</span>}
              {identity.partsVisible && partsWaitingCount > 0 && <span className="text-amber-400 normal-case"> · {partsWaitingCount} waiting</span>}
            </span>
            <span aria-hidden className="text-gray-500 transition-transform group-open:rotate-90">›</span>
          </summary>
          <div className="mt-2">
            {identity.partsVisible
              ? <PartsSection orderId={order.id} hideTitle onPartsChange={onPartsChange}
                  onEditPart={itemsView ? (id) => items.openPart(id) : undefined} editableIds={editablePartIds} refreshKey={partsKey} />
              : itemsView && itemsView.parts && itemsView.parts.length > 0 ? (
                <ul aria-label="Parts" className="rounded-2xl border border-gray-800 bg-gray-900 divide-y divide-gray-800 overflow-hidden">
                  {itemsView.parts.map((p) => (
                    <PartRow key={p.id} p={p} readOnly={false} busy={items.busy} onOpen={() => items.openPart(p.id)} onRemove={() => items.removePart(p)()} />
                  ))}
                </ul>
              ) : (
                <ul className="rounded-2xl border border-gray-800 bg-gray-900 divide-y divide-gray-800">
                  {activePartLabels.map((p, i) => <li key={i} className="px-4 py-3 text-gray-200 text-sm">{p}</li>)}
                </ul>
              )}
          </div>
        </details>
      )}

      {isManager && <div className="px-6 mb-6"><OrderPhotos orderId={order.id} /></div>}

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

      {/* ── Job Management (manager/admin only) — the USEFUL controls, without the old clutter ──
          Restores Invoice Draft, Estimate, Production Date, Reopen + Activity (all reusing the existing
          components/state/APIs). INTENTIONALLY still hidden: the old "Manager controls" heading, the
          Waiting/SO#/tech/timer meta line, and the granular status buttons (Start Work / Cancel / Pause /
          QC / Deliver / Send Back). Ordinary employees keep the clean operational page above. UI hiding
          is not the security boundary — each endpoint still enforces its own manager/admin authorization. */}
      {isManager && (
        <div className="px-6 mt-2 mb-8 border-t border-gray-900 pt-5">
          <h2 className="text-gray-600 text-xs font-semibold uppercase tracking-widest mb-3">Job Management</h2>

          {/* View / Edit Invoice — ONE entry: edit services/prices and review the Invoice Draft (fees, tax,
              total, explicit QuickBooks Create/Sync/Send) on one page. Opening it never creates or sends.
              Without the estimate layer it falls back to the Invoice Draft sheet. */}
          {identity.estimateEnabled ? (
            <a href={`/orders/${order.id}/estimate`}
              className="block w-full text-center text-white font-semibold text-base py-3.5 rounded-2xl bg-indigo-600 active:opacity-80 mb-4">
              View / Edit Invoice
            </a>
          ) : (
            <button onClick={() => setShowInvoice(true)}
              className="w-full text-white font-semibold text-base py-3.5 rounded-2xl bg-indigo-600 active:opacity-80 mb-4">
              View / Edit Invoice
            </button>
          )}

          {/* Move to Estimates — correct a retail vehicle that was checked in but should be a quote.
              Only while it's still waiting (arrived, untouched); the confirm sheet explains + fails closed. */}
          {identity.estimateEnabled && orderSourceKind(order) === 'retail' && order.status === 'arrived' && !order.startedAt && !order.completedAt && (
            <button disabled={moveBusy} onClick={openMoveConfirm} className="w-full text-sky-300 font-semibold text-sm py-3 rounded-2xl border border-sky-800/60 bg-sky-950/30 active:opacity-80 disabled:opacity-50 mb-4">
              {moveBusy ? 'Moving…' : 'Move to Estimates'}
            </button>
          )}

          {/* Production Date — move a completed Job to a different Daily Production day
              (override; never changes completed_at). Self-hides for non-completed Jobs. */}
          {order.completedAt && <ProductionDateSection orderId={order.id} onChanged={reload} />}

          {/* reopen a Ready Job that wasn't truly finished (reason + PIN) */}
          {order.status === 'ready' && (
            <button onClick={() => { setReopenMsg(null); setReopening(true) }}
              className="w-full text-amber-300 font-semibold text-sm py-3 rounded-2xl border border-amber-800/60 bg-amber-950/30 active:opacity-80 mb-4">
              Reopen Job
            </button>
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
        />
      )}

      {/* Reopen (reason + PIN) */}
      {reopening && (
        <ReopenModal busy={reopenBusy} error={reopenMsg} onConfirm={submitReopen} onCancel={() => setReopening(false)} />
      )}

      {/* Customer contact popup (all staff) */}
      {showContact && (
        <CustomerContactModal orderId={order.id} customerName={title} onClose={() => setShowContact(false)} />
      )}

      {/* Move-to-Estimates confirm — shows customer + vehicle, the plain-language explanation, or the
          specific reason the move is blocked. A Pitt Stop status move only: QuickBooks is never
          touched, and a linked invoice stays exactly as it is. */}
      {confirmMove && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4" onClick={() => !moveBusy && setConfirmMove(false)}>
          <div className="w-full max-w-md rounded-2xl bg-gray-900 border border-gray-800 p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-white font-bold text-lg">Move to Estimates?</p>
            <p className="text-white text-base font-semibold mt-1">{title}</p>
            <p className="text-gray-400 text-sm">{vehicleName}</p>
            <p className="text-gray-300 text-sm mt-3">This removes the job from the Work Board and keeps its information in Estimates — customer, services, prices, notes, photos, and history are all kept. Any QuickBooks invoice is left unchanged.</p>

            {movePreviewLoading && <p className="text-gray-500 text-sm mt-4">Checking…</p>}
            {!movePreviewLoading && movePreview && !movePreview.eligible && (
              <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 mt-4">
                <p className="text-red-300 text-sm">{movePreview.reason ?? 'This job can’t move to Estimates right now.'}</p>
              </div>
            )}
            {error && <p className="text-red-400 text-sm mt-3">{error}</p>}

            <div className="flex gap-2 mt-5">
              <button onClick={() => setConfirmMove(false)} disabled={moveBusy} className="flex-1 h-12 rounded-2xl bg-gray-800 active:bg-gray-700 text-gray-200 font-semibold disabled:opacity-40">
                {movePreview && !movePreview.eligible ? 'Close' : 'Cancel'}
              </button>
              {(!movePreview || movePreview.eligible) && (
                <button disabled={moveBusy || movePreviewLoading} onClick={async () => {
                  setMoveBusy(true); setError(null)
                  try {
                    const response = await fetch(`/api/workflow/orders/${order.id}/move-to-estimates`, { method: 'POST' })
                    const data = await response.json()
                    if (!response.ok) throw new Error(data.error || 'Unable to move this job.')
                    setConfirmMove(false)
                    router.push(data.href); router.refresh()
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Unable to move this job.')
                  } finally { setMoveBusy(false) }
                }} className="flex-[2] h-12 rounded-2xl bg-blue-600 active:bg-blue-700 disabled:opacity-40 text-white font-bold">
                  {moveBusy ? 'Moving…' : 'Move to Estimates'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Invoice Draft (manager/admin) */}
      {showInvoice && (
        <InvoiceDraftModal orderId={order.id} onClose={() => setShowInvoice(false)} />
      )}

      {/* Phase A: post-Finish Completion Summary / billing handoff (manager/admin, retail).
          Completion is already committed when this opens; Done returns to the Work Board. */}
      {summaryOpen && (
        <CompletionSummary
          orderId={order.id}
          customerName={title}
          vehicleName={vehicleName}
          onDone={() => { setSummaryOpen(false); router.push('/work-board') }}
        />
      )}

      {/* Item editor sheet + save status (tap-to-edit Services / Parts) */}
      {items.ui}

      {/* Edit Vehicle (manager correction) */}
      {editingVehicle && (
        <VehicleEditModal
          orderId={order.id}
          onClose={() => setEditingVehicle(false)}
          onSaved={async (msg) => { setEditingVehicle(false); setVehToast(msg); await reload(); setTimeout(() => setVehToast(null), 6000) }}
        />
      )}

      {/* Edit Customer (manager correction of name/phone/email) */}
      {editingCustomer && (
        <CustomerEditModal
          orderId={order.id}
          onClose={() => setEditingCustomer(false)}
          onSaved={async (msg) => { setEditingCustomer(false); setVehToast(msg); await reload(); setTimeout(() => setVehToast(null), 6000) }}
        />
      )}


    </main>
  )
}
