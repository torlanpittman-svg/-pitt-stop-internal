'use client'
/**
 * Write-a-Check flow (mobile-first). Steps: FORM → REVIEW (resolve payee + confirm) → result. The real
 * money mutation happens only when the manager taps "Record & Print Check" on the confirmation card;
 * printing happens on /checks/print after a successful QuickBooks recording. Idempotency key is minted
 * once per confirmation and reused across retries so a double-tap never writes two checks.
 */
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { CheckView } from '@/apps/checks/types'
import GlobalSearch from '@/app/components/GlobalSearch'
import CheckPrintPanel from './CheckPrintPanel'

type Bank = { key: 'operating' | 'auto_sales'; qboAccountId: string; label: string }
type Cat = { key: string; label: string; entity: 'operating' | 'auto_sales'; hint: string; linksJob: boolean; linksVehicle: boolean }
type LinkOption = { id: string; label: string; sub?: string | null }
type Readiness = { ready: boolean; enabled: boolean; operatingBankConfigured: boolean; autoSalesBankConfigured: boolean; missingCategoryAccounts: string[] }
type PayeeType = 'Vendor' | 'Employee' | 'Customer'
type PayeeMatch = { id: string; type: PayeeType; displayName: string; active: boolean }
// Mirrors apps/checks/payee.ts#PayeePreview.
type Preview =
  | { decision: 'use'; payee: PayeeMatch }
  | { decision: 'ambiguous'; matches: PayeeMatch[] }
  | { decision: 'blocked'; message: string; conflicts: PayeeMatch[] }
  | { decision: 'create' }
const PAYEE_TYPE_LABEL: Record<PayeeType, string> = { Vendor: 'vendor', Employee: 'employee', Customer: 'customer' }

interface Props {
  actorName: string
  enabled: boolean
  liveEnabled: boolean
  readiness: Readiness
  banks: Record<'operating' | 'auto_sales', Bank>
  categories: Cat[]
  nextNumbers: { operating: number | null; auto_sales: number | null }
  recent: CheckView[]
}

const fmt = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ── Presentation only (dark operational theme; no behavior lives in these strings) ──
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500'
// Payee / memo / vehicle / bank / vendor / error text is financial identity: it wraps in full (even one
// long unbroken string) and is never truncated or shrunk to fit.
const WRAP = 'min-w-0 [overflow-wrap:anywhere]'
const CONTROL = 'w-full rounded-xl border border-gray-700 bg-gray-800 px-4 text-base text-white transition-colors placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500'
const LABEL = 'mb-2 block text-sm font-medium text-gray-300'
// Selectable tiles (category / vehicle picker).
const TILE = `w-full min-w-0 min-h-12 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors [overflow-wrap:anywhere] ${FOCUS}`
const TILE_ON = 'border-blue-500 bg-blue-950/40 text-white ring-1 ring-blue-500'
const TILE_OFF = 'border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-600'
// Actions grow with their label (min-h, never a fixed h) so a long label wraps instead of clipping.
const ACTION = `flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-center text-base font-semibold transition-colors [overflow-wrap:anywhere] disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`
const ACTION_PRIMARY = `${ACTION} bg-blue-600 text-white hover:bg-blue-500 active:bg-blue-700`
// Emerald is reserved for the one button that records real money.
const ACTION_CONFIRM = `${ACTION} bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700`
const ACTION_SECONDARY = `flex min-h-11 w-full items-center justify-center rounded-xl border border-gray-700 px-4 py-2 text-center text-sm font-semibold text-gray-200 transition-colors [overflow-wrap:anywhere] hover:border-gray-600 hover:bg-gray-800/60 disabled:opacity-50 ${FOCUS}`
const DASHED_ACTION = `flex min-h-11 w-full items-center justify-center rounded-xl border border-dashed border-gray-700 px-4 py-2 text-center text-sm font-medium text-gray-400 transition-colors hover:border-gray-600 hover:text-gray-200 disabled:opacity-50 ${FOCUS}`
const ALERT = 'rounded-xl border px-4 py-3 text-sm/relaxed'
const ALERT_WARNING = `${ALERT} border-amber-900/60 bg-amber-950/30 text-amber-200`
const ALERT_ERROR = `${ALERT} border-red-900/60 bg-red-950/30 text-red-200`
const ALERT_SUCCESS = `${ALERT} border-emerald-900/60 bg-emerald-950/30 text-emerald-200`
const STATUS_CHIP = 'rounded-md border border-gray-700 px-2 py-0.5 text-xs text-gray-300'

function parseAmountToCents(s: string): number {
  const n = Math.round(parseFloat(s.replace(/[^0-9.]/g, '')) * 100)
  return Number.isFinite(n) ? n : NaN
}

export default function WriteCheckFlow(props: Props) {
  const router = useRouter()
  const [step, setStep] = useState<'form' | 'review' | 'result'>('form')

  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [purpose, setPurpose] = useState('')
  const [category, setCategory] = useState('shop_general')

  // Optional soft link to a Work Board job (Customer Vehicle) or Auto Sales vehicle.
  const [linkId, setLinkId] = useState<string | null>(null)
  const [linkLabel, setLinkLabel] = useState<string | null>(null)
  const [linkOptions, setLinkOptions] = useState<LinkOption[]>([])
  const [linkLoading, setLinkLoading] = useState(false)

  const [preview, setPreview] = useState<Preview | null>(null)
  const [chosenPayee, setChosenPayee] = useState<PayeeMatch | null>(null)
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [idemKey, setIdemKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ recorded: boolean; check: CheckView; error?: string } | null>(null)
  const [jobStatus, setJobStatus] = useState<string | null>(null)

  // Presentation only: each step is a different-height screen, so start it at the top instead of keeping
  // the previous step's scroll offset (which hid the payee under the sticky header). Skips first mount.
  const lastStep = useRef(step)
  useEffect(() => {
    if (lastStep.current === step) return
    lastStep.current = step
    window.scrollTo(0, 0)
  }, [step])

  const cat =props.categories.find((c) => c.key === category)!
  const entity = cat.entity
  const bank = props.banks[entity]
  const nextNumber = props.nextNumbers[entity]
  const amountCents = parseAmountToCents(amount)
  const amountValid = Number.isInteger(amountCents) && amountCents > 0
  const categoryConfigured = !props.readiness.missingCategoryAccounts.includes(category)
  const bankConfigured = entity === 'operating' ? props.readiness.operatingBankConfigured : props.readiness.autoSalesBankConfigured
  const linkKind: 'job' | 'vehicle' | null = cat.linksJob ? 'job' : cat.linksVehicle ? 'vehicle' : null

  async function selectCategory(key: string) {
    setCategory(key)
    const next = props.categories.find((c) => c.key === key)!
    const kind = next.linksJob ? 'job' : next.linksVehicle ? 'vehicle' : null
    setLinkId(null); setLinkLabel(null); setLinkOptions([])
    if (!kind) return
    setLinkLoading(true)
    try {
      const res = await fetch(`/api/checks/links?kind=${kind}`)
      const data = await res.json()
      if (res.ok) setLinkOptions(data.options ?? [])
    } catch { /* picker is optional — ignore load failure */ } finally { setLinkLoading(false) }
  }

  // ── Not configured yet ──
  if (!props.enabled || !props.readiness.operatingBankConfigured) {
    return (
      <Shell actorName={props.actorName}>
        <div role="status" className={ALERT_WARNING}>
          <p className="font-semibold">Check writing isn’t set up yet.</p>
          <ul className={`mt-2 list-disc pl-5 ${WRAP}`}>
            {!props.enabled && <li>Feature is turned off (enable it in Admin → Checks).</li>}
            {!props.readiness.operatingBankConfigured && <li>Operating bank account (*2649) not selected.</li>}
            {props.readiness.missingCategoryAccounts.length > 0 && <li>Expense accounts not mapped for: {props.readiness.missingCategoryAccounts.join(', ')}.</li>}
          </ul>
          <p className="mt-3">Ask the owner to finish setup at <span className="font-mono">/admin/checks</span>.</p>
        </div>
      </Shell>
    )
  }

  async function goReview() {
    setError(null)
    if (!payee.trim()) return setError('Enter who you are paying.')
    if (!amountValid) return setError('Enter a valid amount greater than $0.00.')
    if (!bankConfigured) return setError(`No bank account configured for ${entity === 'auto_sales' ? 'Auto Sales' : 'operating'} checks.`)
    if (!categoryConfigured) return setError(`No expense account mapped for “${cat.label}”. Ask the owner to finish setup.`)
    setBusy(true)
    try {
      const res = await fetch('/api/checks/resolve-payee', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payeeName: payee.trim() }) })
      const data = await res.json()
      // A failed lookup is NOT "no such payee" — stay on the form and say the lookup failed.
      if (!res.ok) throw new Error(data.message || 'Could not reach QuickBooks to look up this payee. Nothing was recorded — try again in a moment.')
      setPreview(data)
      setChosenPayee(data.decision === 'use' ? data.payee : null)
      setConfirmCreate(false)
      setIdemKey(crypto.randomUUID())
      setStep('review')
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  async function record() {
    setError(null)
    if (!props.liveEnabled) return setError('Live check recording is disabled until MICR/hardware setup is complete. Use the VOID test to preview.')
    // Payee must be resolvable: an existing QuickBooks payee, an explicit pick, or a confirmed new vendor.
    if (preview?.decision === 'blocked') return setError(preview.message)
    if (preview?.decision === 'ambiguous' && !chosenPayee) return setError('Pick which QuickBooks record this payee is.')
    if (preview?.decision === 'create' && !confirmCreate) return setError('Tick the box to confirm adding this payee to QuickBooks as a new vendor.')
    setBusy(true)
    try {
      const res = await fetch('/api/checks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payeeName: payee.trim(),
          vendorId: chosenPayee?.id ?? null,
          payeeType: chosenPayee?.type ?? null,
          allowCreateVendor: preview?.decision === 'create' ? confirmCreate : false,
          amountCents, memo: purpose.trim() || null, category,
          linkedJobId: linkKind === 'job' ? linkId : null,
          linkedVehicleId: linkKind === 'vehicle' ? linkId : null,
          idempotencyKey: idemKey,
        }),
      })
      const data = await res.json()
      // Payee outcomes found at record time. Nothing was recorded and no check number was used, so the
      // review card is updated in place and the manager confirms again.
      if (res.status === 409 && data.error === 'ambiguous_payee') { setPreview({ decision: 'ambiguous', matches: data.matches ?? [] }); setChosenPayee(null); throw new Error(data.message) }
      if (res.status === 409 && data.error === 'payee_exists') { setPreview({ decision: 'use', payee: data.payee }); setChosenPayee(data.payee); setConfirmCreate(false); throw new Error(data.message) }
      if (res.status === 409 && data.error === 'payee_blocked') { setPreview({ decision: 'blocked', message: data.message, conflicts: data.conflicts ?? [] }); setChosenPayee(null); throw new Error(data.message) }
      if (res.status === 409 && data.error === 'payee_not_found') { setPreview({ decision: 'create' }); setChosenPayee(null); setConfirmCreate(false); throw new Error(data.message) }
      if (!res.ok && !data.check) throw new Error(data.message || 'Could not record the check.')
      setResult({ recorded: !!data.recorded, check: data.check, error: data.error })
      setStep('result')
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  // ── RESULT ──
  if (step === 'result' && result) {
    const c = result.check
    return (
      <Shell actorName={props.actorName}>
        {result.recorded ? (
          <div className="space-y-4">
            <div role="status" className={ALERT_SUCCESS}>
              <p className="font-semibold">Recorded in QuickBooks ✓</p>
              <dl className={`mt-1 ${WRAP}`}>
                <dt className="sr-only">Check number</dt>
                <dd className="tabular-nums">Check #{c.checkNumber}</dd>
                <dt className="sr-only">Pay to</dt>
                <dd className="mt-1 text-base font-semibold text-white">{c.payeeName}</dd>
                <dt className="sr-only">Amount</dt>
                <dd className="mt-1 text-2xl font-bold tabular-nums text-white">{fmt(c.amountCents)}</dd>
                <dt className="sr-only">From</dt>
                <dd className="mt-1">From {c.bankLabel}</dd>
              </dl>
            </div>
            <p className="text-sm text-gray-400">Send it to the always-on shop printer. Make sure the check stock is loaded in the Brother.</p>
            {/* CheckPrintPanel owns send / poll / manager confirmation / failure visibility and is styled
                for a light surface — give it one here rather than restyling or replacing it. */}
            <div className={`rounded-2xl bg-white p-4 text-neutral-900 ${WRAP}`}>
              <CheckPrintPanel checkId={c.id} checkNumber={c.checkNumber} printStatus={c.printStatus} />
            </div>
            <button type="button" onClick={resetAll} className={ACTION_SECONDARY}>Write another</button>
          </div>
        ) : (
          <div className="space-y-4">
            <div role="alert" className={ALERT_ERROR}>
              <p className="font-semibold">QuickBooks recording needs attention.</p>
              <p className="mt-1">Check #{c.checkNumber} is reserved for this check and nothing was printed. Once the issue below is addressed, Retry sends this same check with the same number — it does not start a new one.</p>
              {result.error && <p className={`mt-2 font-mono text-sm ${WRAP}`}>{result.error}</p>}
            </div>
            {error && error !== result.error && (
              <div role="alert" className={ALERT_ERROR}>
                <p className="font-semibold">Retry did not go through.</p>
                <p className={`mt-1 ${WRAP}`}>{error}</p>
              </div>
            )}
            <button type="button" disabled={busy} onClick={retryQb} className={ACTION_PRIMARY}>{busy ? 'Retrying…' : 'Retry QuickBooks'}</button>
            <button type="button" onClick={resetAll} className={ACTION_SECONDARY}>Start over</button>
          </div>
        )}
      </Shell>
    )
  }

  // ── REVIEW / CONFIRM ──
  if (step === 'review') {
    return (
      <Shell actorName={props.actorName}>
        <button type="button" onClick={() => setStep('form')} className={`-mt-2 mb-2 flex min-h-11 items-center gap-1.5 text-sm font-medium text-blue-400 hover:text-blue-300 ${FOCUS}`}><span aria-hidden="true">←</span>Edit details</button>
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="text-lg font-bold text-white">Review this check</h2>
          <dl className="mt-2 divide-y divide-gray-800">
            <Row label="Pay to"><span className="text-lg font-semibold text-white">{payee.trim()}</span></Row>
            <Row label="Amount"><span className="text-3xl font-bold tabular-nums text-white">{amountValid ? fmt(amountCents) : '—'}</span></Row>
            {purpose.trim() && <Row label="For">{purpose.trim()}</Row>}
            <Row label="From">{bank.label}</Row>
            <Row label="Category">{cat.label}{entity === 'auto_sales' && <span className="ml-2 inline-block rounded-full border border-purple-900/60 bg-purple-950/40 px-2 py-0.5 text-xs font-semibold text-purple-300">Auto Sales — separate</span>}</Row>
            {linkKind && <Row label={linkKind === 'job' ? 'Customer vehicle' : 'Auto Sales vehicle'}>{linkLabel ?? 'Not specified'}</Row>}
            <Row label="Check #"><span className="tabular-nums">{nextNumber != null ? `${nextNumber} (next)` : '—'}</span></Row>
          </dl>

          {/* Payee resolution */}
          <div className="mt-4 rounded-xl border border-gray-700 bg-gray-950/60 p-3 text-sm text-gray-200">
            {preview?.decision === 'use' && (
              <p className={WRAP}>
                Existing QuickBooks payee found: <b className="text-white">{preview.payee.displayName}</b>
                <span className={`ml-2 ${STATUS_CHIP}`}>QuickBooks {PAYEE_TYPE_LABEL[preview.payee.type]}</span>
              </p>
            )}
            {preview?.decision === 'create' && (
              <div>
                <p className={WRAP}>“{payee.trim()}” is not in QuickBooks yet (no vendor, employee or customer has this name). Create a new vendor?</p>
                <label className="mt-1 flex min-h-11 cursor-pointer items-start gap-3 py-2">
                  <input type="checkbox" checked={confirmCreate} onChange={(e) => setConfirmCreate(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-blue-600" />
                  <span className={WRAP}>Yes — add “{payee.trim()}” to QuickBooks as a new vendor.</span>
                </label>
              </div>
            )}
            {preview?.decision === 'ambiguous' && (
              <div>
                <p className="mb-2 text-amber-300">This name matches more than one QuickBooks record. Pick the right one:</p>
                <div className="space-y-1">
                  {preview.matches.map((m) => (
                    <label key={`${m.type}:${m.id}`} className="flex min-h-11 cursor-pointer items-start gap-3 py-2">
                      <input type="radio" name="payee" checked={chosenPayee?.id === m.id && chosenPayee?.type === m.type} onChange={() => setChosenPayee(m)} className="mt-0.5 h-5 w-5 shrink-0 accent-blue-600" />
                      <span className={WRAP}>{m.displayName} <span className={`ml-1 ${STATUS_CHIP}`}>{PAYEE_TYPE_LABEL[m.type]}</span></span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {preview?.decision === 'blocked' && (
              <div role="alert" className="text-amber-200">
                <p className="font-semibold">This check can’t be written to this name yet.</p>
                <p className={`mt-1 ${WRAP}`}>{preview.message}</p>
              </div>
            )}
          </div>
        </div>

        {error && <p role="alert" className={`mt-3 ${ALERT_ERROR} ${WRAP}`}>{error}</p>}
        {props.liveEnabled ? (
          <button type="button" disabled={busy || preview?.decision === 'blocked'} onClick={record} className={`mt-4 ${ACTION_CONFIRM}`}>
            {busy ? 'Recording…' : 'Record & Print Check'}
          </button>
        ) : (
          <div className="mt-4">
            <div role="status" className={ALERT_WARNING}>
              <p className="font-semibold">Preview only — negotiable check printing isn’t enabled yet.</p>
              <p className="mt-1">Recording a real check (QuickBooks + check number) is disabled until MICR/hardware setup is finished and the owner turns on live checks. Everything above is exactly what a real check will record.</p>
            </div>
            <button type="button" disabled className="mt-3 flex min-h-14 w-full cursor-not-allowed items-center justify-center rounded-xl border border-gray-700 bg-gray-800 px-5 py-3 text-center text-base font-semibold text-gray-400">Record &amp; Print Check — disabled</button>
            <button type="button" disabled={busy} onClick={sendTestToShopPrinter} className={`mt-2 ${DASHED_ACTION}`}>Send a VOID (non-negotiable) test print instead</button>
            {jobStatus && <div className="mt-2"><PrinterStatus status={jobStatus} /></div>}
          </div>
        )}
        <button type="button" onClick={() => setStep('form')} className={`mt-2 ${ACTION_SECONDARY}`}>{props.liveEnabled ? 'Cancel' : 'Back'}</button>
      </Shell>
    )
  }

  // ── FORM ──
  return (
    <Shell actorName={props.actorName}>
      <div className="space-y-5">
        {!props.liveEnabled && (
          <div role="status" className={ALERT_WARNING}>
            <span className="font-semibold">Preview mode.</span> Walk the full workflow and send VOID (non‑negotiable) test prints. Recording a real check is off until MICR/hardware setup is finished.
          </div>
        )}
        <div className="min-w-0">
          <label htmlFor="check-payee" className={LABEL}>Pay to</label>
          <input id="check-payee" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Who are you paying?" className={`${CONTROL} min-h-11 py-2`} />
          {/* The input scrolls a long name sideways; this readout shows all of it while typing. */}
          {payee.trim() && (
            <p className={`mt-2 border-l-2 border-blue-500 pl-3 text-base font-semibold text-white ${WRAP}`}>
              <span className="block text-xs font-normal text-gray-400">Check will be made out to</span>
              {payee.trim()}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <label htmlFor="check-amount" className={LABEL}>Amount</label>
          <div className="flex min-h-14 items-center rounded-xl border border-gray-700 bg-gray-800 px-4 transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500">
            <span className="text-2xl text-gray-400">$</span>
            <input id="check-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full min-w-0 bg-transparent py-2 pl-2 text-2xl font-semibold tabular-nums text-white outline-none placeholder:font-normal placeholder:text-gray-500" />
          </div>
        </div>
        <div className="min-w-0">
          <label htmlFor="check-purpose" className={LABEL}>What is this for?</label>
          {/* Multi-line so a long memo is readable in full. The stored value stays single-line exactly as
              the old text input kept it: Enter is ignored and pasted CR/LF characters are stripped. */}
          <textarea id="check-purpose" rows={2} value={purpose}
            onChange={(e) => setPurpose(e.target.value.replace(/[\r\n]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
            placeholder="Purpose / memo" className={`${CONTROL} min-h-24 py-3 [field-sizing:content]`} />
        </div>
        <fieldset className="min-w-0">
          <legend className={LABEL}>Category</legend>
          <div className="grid grid-cols-2 gap-2">
            {props.categories.map((c) => (
              <button key={c.key} type="button" aria-pressed={category === c.key} onClick={() => selectCategory(c.key)}
                className={`${TILE} ${category === c.key ? TILE_ON : TILE_OFF}`}>
                <div className="font-medium">{c.label}</div>
                {c.entity === 'auto_sales' && <div className="text-xs text-purple-300">separate books</div>}
              </button>
            ))}
          </div>
          <p className={`mt-2 text-sm text-gray-400 ${WRAP}`}>Paid from {bank.label}</p>
          {!categoryConfigured && <p className="mt-1 text-sm text-amber-300">No expense account mapped for this category yet.</p>}
        </fieldset>

        {/* Optional attribution: Customer Vehicle → Work Board job; Auto Sales → inventory vehicle. */}
        {linkKind && (
          <fieldset className="min-w-0">
            <legend className={LABEL}>{linkKind === 'job' ? 'Which customer vehicle? (optional)' : 'Which Auto Sales vehicle? (optional)'}</legend>
            {linkLoading ? (
              <p className="text-sm text-gray-400">Loading…</p>
            ) : linkOptions.length === 0 ? (
              <p className="text-sm text-gray-400">{linkKind === 'job' ? 'No vehicles on the Work Board right now.' : 'No inventory vehicles found.'}</p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-2xl border border-gray-800 bg-gray-900 p-2">
                <button type="button" aria-pressed={linkId === null} onClick={() => { setLinkId(null); setLinkLabel(null) }}
                  className={`${TILE} ${linkId === null ? TILE_ON : TILE_OFF}`}>None / not vehicle-specific</button>
                {linkOptions.map((o) => (
                  <button key={o.id} type="button" aria-pressed={linkId === o.id} onClick={() => { setLinkId(o.id); setLinkLabel(o.label) }}
                    className={`${TILE} ${linkId === o.id ? TILE_ON : TILE_OFF}`}>
                    <div className="font-medium">{o.label}</div>
                    {o.sub && <div className={`text-xs ${linkId === o.id ? 'text-gray-300' : 'text-gray-400'}`}>{o.sub}</div>}
                  </button>
                ))}
              </div>
            )}
          </fieldset>
        )}

        {error && <p role="alert" className={`${ALERT_ERROR} ${WRAP}`}>{error}</p>}
        <button type="button" disabled={busy} onClick={goReview} className={ACTION_PRIMARY}>{busy ? 'Checking…' : 'Review check'}</button>

        <div className="pt-2">
          <button type="button" disabled={busy} onClick={sendTestToShopPrinter} className={DASHED_ACTION}>Send VOID test page to shop printer (no check recorded)</button>
          <a href="/checks/print?test=1" className={`flex min-h-11 w-full items-center justify-center text-center text-sm text-gray-400 underline underline-offset-2 hover:text-white ${FOCUS}`}>or preview/print on this device</a>
        </div>
        {jobStatus && <PrinterStatus status={jobStatus} />}

        {props.recent.length > 0 && (
          <section aria-labelledby="recent-checks-heading" className="border-t border-gray-800 pt-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4">
              <h2 id="recent-checks-heading" className="text-lg font-bold text-white">Recent checks</h2>
              <a href="/checks/history" className={`flex min-h-11 items-center text-sm font-medium text-blue-400 hover:text-blue-300 ${FOCUS}`}>See all checks</a>
            </div>
            <div className="space-y-3">
              {props.recent.map((c) => (
                <article key={c.id} className="min-w-0 rounded-2xl border border-gray-800 bg-gray-900 p-4">
                  <a href={`/checks/${c.id}`} className={`block min-w-0 rounded-lg ${FOCUS}`}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold tabular-nums text-gray-200">Check #{c.checkNumber}</span>
                      <span className={STATUS_CHIP}>QuickBooks: {c.qbStatus.replace(/_/g, ' ')}</span>
                      {c.printStatus !== 'not_printed' && <span className={STATUS_CHIP}>Print: {c.printStatus.replace(/_/g, ' ')}</span>}
                    </div>
                    <p className={`mt-2 text-base font-semibold text-white ${WRAP}`}>{c.payeeName}</p>
                    <p className={`mt-1 text-sm text-gray-400 ${WRAP}`}>{c.categoryLabel}</p>
                  </a>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-gray-800 pt-3">
                    <span className="text-lg font-semibold tabular-nums text-white">{fmt(c.amountCents)}</span>
                    {/* Goes to the check's detail page, where the print panel lives — never a direct reprint. */}
                    {c.qbStatus === 'recorded' && <a href={`/checks/${c.id}`} aria-label={`${c.printStatus === 'printed' ? 'View' : 'Print'} check #${c.checkNumber}`} className={`flex min-h-11 min-w-24 items-center justify-center rounded-xl border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-200 transition-colors hover:border-gray-600 hover:bg-gray-800/60 ${FOCUS}`}>{c.printStatus === 'printed' ? 'View' : 'Print'}</a>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </Shell>
  )

  async function sendTestToShopPrinter() {
    setBusy(true); setError(null); setJobStatus('queuing test page…')
    try {
      const res = await fetch('/api/checks/test-print', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Could not queue the test page.')
      setJobStatus('test page queued — waiting for shop printer…')
      pollTestJob(data.jobId)
    } catch (e) { setError(String((e as Error).message)); setJobStatus(null) } finally { setBusy(false) }
  }

  function pollTestJob(jobId: string, tries = 0) {
    if (tries > 40) { setJobStatus('still queued — is the shop bridge running?'); return }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/checks/jobs/${jobId}`)
        const data = await res.json()
        if (data.status === 'submitted' || data.status === 'printed') { setJobStatus('test page sent to the printer ✓ — check the tray'); return }
        if (data.status === 'expired' || data.status === 'canceled') { setJobStatus('test page expired — the shop printer link did not pick it up.'); return }
        if (data.status === 'failed') { setJobStatus(`test print failed: ${data.error || 'unknown'}`); return }
        setJobStatus(data.status === 'claimed' ? 'printing test page…' : 'test page queued…')
        pollTestJob(jobId, tries + 1)
      } catch { pollTestJob(jobId, tries + 1) }
    }, 2000)
  }

  async function retryQb() {
    if (!result) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/checks/${result.check.id}/retry-qb`, { method: 'POST' })
      const data = await res.json()
      if (data.check) setResult({ recorded: !!data.recorded, check: data.check, error: data.error })
      if (!data.recorded) setError(data.error || data.message || 'Still failing.')
    } catch (e) { setError(String((e as Error).message)) } finally { setBusy(false) }
  }

  function resetAll() {
    setPayee(''); setAmount(''); setPurpose(''); setCategory('shop_general')
    setLinkId(null); setLinkLabel(null); setLinkOptions([])
    setPreview(null); setChosenPayee(null); setConfirmCreate(false); setIdemKey(''); setResult(null); setError(null); setStep('form')
  }
}

function Shell({ actorName, children }: { actorName: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-950 text-gray-200">
      {/* Local header: one Home on the left, search + Check history on the right. */}
      <header className="sticky top-0 z-30 border-b border-gray-900 bg-gray-950/95 backdrop-blur">
        <nav aria-label="Checks" className="mx-auto flex w-full max-w-xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-6">
          <Link href="/" className={`flex min-h-11 items-center gap-1.5 pr-2 font-medium text-gray-300 hover:text-white ${FOCUS}`}><span aria-hidden="true">←</span>Home</Link>
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">
            {/* The shared search trigger is only icon-wide; give it a 44px tap target from here. */}
            <div className="flex items-center [&>button]:min-h-11 [&>button]:min-w-11 [&>button]:justify-center"><GlobalSearch /></div>
            <a href="/checks/history" className={`flex min-h-11 items-center rounded-xl border border-gray-700 px-3 font-medium text-gray-200 transition-colors hover:border-gray-600 hover:bg-gray-800/60 ${FOCUS}`}>Check history</a>
          </div>
        </nav>
      </header>
      <div className="mx-auto w-full min-w-0 max-w-xl px-4 pb-16 pt-5 sm:px-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-white">Write a Check</h1>
          <span className={`text-sm text-gray-400 ${WRAP}`}>{actorName}</span>
        </div>
        {children}
      </div>
    </main>
  )
}
function PrinterStatus({ status }: { status: string }) {
  return <p role="status" className={`rounded-xl border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-gray-200 ${WRAP}`}>Printer: {status}</p>
}
// Label stacked above a left-aligned value on a phone; label column beside it from sm up.
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 py-3 sm:grid sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-baseline sm:gap-4">
      <dt className="text-sm text-gray-400">{label}</dt>
      <dd className={`mt-0.5 text-base text-gray-100 sm:mt-0 ${WRAP}`}>{children}</dd>
    </div>
  )
}
