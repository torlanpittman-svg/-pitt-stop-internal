'use client'
/**
 * Write-a-Check flow (mobile-first). Steps: FORM → REVIEW (resolve payee + confirm) → result. The real
 * money mutation happens only when the manager taps "Record & Print Check" on the confirmation card;
 * printing happens on /checks/print after a successful QuickBooks recording. Idempotency key is minted
 * once per confirmation and reused across retries so a double-tap never writes two checks.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CheckView } from '@/apps/checks/types'

type Bank = { key: 'operating' | 'auto_sales'; qboAccountId: string; label: string }
type Cat = { key: string; label: string; entity: 'operating' | 'auto_sales'; hint: string; linksJob: boolean; linksVehicle: boolean }
type LinkOption = { id: string; label: string; sub?: string | null }
type Readiness = { ready: boolean; enabled: boolean; operatingBankConfigured: boolean; autoSalesBankConfigured: boolean; missingCategoryAccounts: string[] }
type VendorMatch = { id: string; displayName: string }
type Preview = { decision: 'use' | 'create' | 'ambiguous'; vendorId?: string; displayName?: string; matches: VendorMatch[]; suggestions: VendorMatch[] }

interface Props {
  actorName: string
  enabled: boolean
  readiness: Readiness
  banks: Record<'operating' | 'auto_sales', Bank>
  categories: Cat[]
  nextNumbers: { operating: number | null; auto_sales: number | null }
  recent: CheckView[]
}

const fmt = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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
  const [chosenVendorId, setChosenVendorId] = useState<string | null>(null)
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [idemKey, setIdemKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ recorded: boolean; check: CheckView; error?: string } | null>(null)
  const [jobStatus, setJobStatus] = useState<string | null>(null)

  const cat = props.categories.find((c) => c.key === category)!
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
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
          <p className="font-semibold">Check writing isn’t set up yet.</p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {!props.enabled && <li>Feature is turned off (enable it in Admin → Checks).</li>}
            {!props.readiness.operatingBankConfigured && <li>Operating bank account (*2649) not selected.</li>}
            {props.readiness.missingCategoryAccounts.length > 0 && <li>Expense accounts not mapped for: {props.readiness.missingCategoryAccounts.join(', ')}.</li>}
          </ul>
          <p className="mt-3 text-sm">Ask the owner to finish setup at <span className="font-mono">/admin/checks</span>.</p>
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
      if (!res.ok) throw new Error(data.message || 'Could not look up the payee.')
      setPreview(data)
      setChosenVendorId(data.decision === 'use' ? data.vendorId : null)
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
    // Payee must be resolvable: an exact existing vendor, an explicit pick, or a confirmed create.
    const needsPick = preview?.decision === 'ambiguous' && !chosenVendorId
    const needsCreateConfirm = preview?.decision === 'create' && !confirmCreate
    if (needsPick) return setError('Pick which vendor this payee is.')
    if (needsCreateConfirm) return setError('Confirm creating a new vendor for this payee.')
    setBusy(true)
    try {
      const res = await fetch('/api/checks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payeeName: payee.trim(),
          vendorId: chosenVendorId,
          allowCreateVendor: preview?.decision === 'create' ? confirmCreate : false,
          amountCents, memo: purpose.trim() || null, category,
          linkedJobId: linkKind === 'job' ? linkId : null,
          linkedVehicleId: linkKind === 'vehicle' ? linkId : null,
          idempotencyKey: idemKey,
        }),
      })
      const data = await res.json()
      if (res.status === 409 && data.error === 'ambiguous_vendor') { setPreview({ decision: 'ambiguous', matches: data.matches ?? [], suggestions: [] }); setChosenVendorId(null); throw new Error('This payee matches more than one vendor — pick one.') }
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
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-900">
              <p className="font-semibold">Recorded in QuickBooks ✓</p>
              <p className="text-sm">Check #{c.checkNumber} to {c.payeeName} for {fmt(c.amountCents)} from {c.bankLabel}.</p>
            </div>
            <p className="text-sm text-neutral-600">Send it to the always-on shop printer. Make sure the check stock is loaded in the Brother.</p>
            <button disabled={busy} onClick={() => sendToShopPrinter(c.id, false)} className="w-full rounded-xl bg-neutral-900 py-4 text-lg font-semibold text-white disabled:opacity-50">{busy ? 'Sending…' : `Send Check #${c.checkNumber} to Shop Printer`}</button>
            {jobStatus && <p className="text-center text-sm text-neutral-600">Printer: {jobStatus}</p>}
            <a href={`/checks/print?id=${c.id}`} className="block w-full rounded-xl border border-neutral-300 py-3 text-center text-sm font-medium text-neutral-600">Print on this device instead (dev/calibration)</a>
            <button onClick={resetAll} className="w-full rounded-xl border border-neutral-300 py-3 font-medium">Write another</button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-red-900">
              <p className="font-semibold">QuickBooks did not record this check.</p>
              <p className="mt-1 text-sm">No check number has been used and nothing was printed. You can safely retry.</p>
              {result.error && <p className="mt-2 break-words font-mono text-xs">{result.error}</p>}
            </div>
            <button disabled={busy} onClick={retryQb} className="w-full rounded-xl bg-neutral-900 py-4 text-lg font-semibold text-white disabled:opacity-50">{busy ? 'Retrying…' : 'Retry QuickBooks'}</button>
            <button onClick={resetAll} className="w-full rounded-xl border border-neutral-300 py-3 font-medium">Start over</button>
          </div>
        )}
      </Shell>
    )
  }

  // ── REVIEW / CONFIRM ──
  if (step === 'review') {
    return (
      <Shell actorName={props.actorName}>
        <button onClick={() => setStep('form')} className="mb-3 text-sm text-neutral-500">← Edit</button>
        <div className="rounded-2xl border border-neutral-300 bg-white p-5 shadow-sm">
          <p className="text-center text-xs uppercase tracking-wide text-neutral-400">Write check?</p>
          <dl className="mt-4 space-y-3 text-sm">
            <Row label="Pay to"><span className="font-semibold">{payee.trim()}</span></Row>
            <Row label="Amount"><span className="text-lg font-bold">{amountValid ? fmt(amountCents) : '—'}</span></Row>
            {purpose.trim() && <Row label="For">{purpose.trim()}</Row>}
            <Row label="From">{bank.label}</Row>
            <Row label="Category">{cat.label}{entity === 'auto_sales' && <span className="ml-2 rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700">Auto Sales — separate</span>}</Row>
            {linkKind && <Row label={linkKind === 'job' ? 'Customer vehicle' : 'Auto Sales vehicle'}>{linkLabel ?? 'Not specified'}</Row>}
            <Row label="Check #">{nextNumber != null ? `${nextNumber} (next)` : '—'}</Row>
          </dl>

          {/* Payee resolution */}
          <div className="mt-4 rounded-lg bg-neutral-50 p-3 text-sm">
            {preview?.decision === 'use' && <p className="text-emerald-700">Existing vendor: <b>{preview.displayName}</b></p>}
            {preview?.decision === 'create' && (
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={confirmCreate} onChange={(e) => setConfirmCreate(e.target.checked)} className="mt-1" />
                <span>No vendor named “{payee.trim()}” exists. Create a new QuickBooks vendor.</span>
              </label>
            )}
            {preview?.decision === 'ambiguous' && (
              <div>
                <p className="mb-2 text-amber-700">This payee matches more than one vendor. Pick the right one:</p>
                <div className="space-y-1">
                  {preview.matches.map((m) => (
                    <label key={m.id} className="flex items-center gap-2">
                      <input type="radio" name="vendor" checked={chosenVendorId === m.id} onChange={() => setChosenVendorId(m.id)} />
                      <span>{m.displayName}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <button disabled={busy} onClick={record} className="mt-4 w-full rounded-xl bg-emerald-600 py-4 text-lg font-semibold text-white disabled:opacity-50">
          {busy ? 'Recording…' : 'Record & Print Check'}
        </button>
        <button onClick={() => setStep('form')} className="mt-2 w-full rounded-xl border border-neutral-300 py-3 font-medium">Cancel</button>
      </Shell>
    )
  }

  // ── FORM ──
  return (
    <Shell actorName={props.actorName}>
      <div className="space-y-5">
        <Field label="Pay to">
          <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Vendor / payee name" className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-lg" />
        </Field>
        <Field label="Amount">
          <div className="flex items-center rounded-xl border border-neutral-300 px-4">
            <span className="text-lg text-neutral-400">$</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full py-3 pl-2 text-lg outline-none" />
          </div>
        </Field>
        <Field label="What is this for?">
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Purpose / memo" className="w-full rounded-xl border border-neutral-300 px-4 py-3" />
        </Field>
        <Field label="Category">
          <div className="grid grid-cols-2 gap-2">
            {props.categories.map((c) => (
              <button key={c.key} onClick={() => selectCategory(c.key)}
                className={`rounded-xl border px-3 py-3 text-left text-sm ${category === c.key ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 bg-white'}`}>
                <div className="font-medium">{c.label}</div>
                {c.entity === 'auto_sales' && <div className={`text-xs ${category === c.key ? 'text-purple-200' : 'text-purple-600'}`}>separate books</div>}
              </button>
            ))}
          </div>
          {!categoryConfigured && <p className="mt-1 text-xs text-amber-600">No expense account mapped for this category yet.</p>}
        </Field>

        {/* Optional attribution: Customer Vehicle → Work Board job; Auto Sales → inventory vehicle. */}
        {linkKind && (
          <Field label={linkKind === 'job' ? 'Which customer vehicle? (optional)' : 'Which Auto Sales vehicle? (optional)'}>
            {linkLoading ? (
              <p className="text-sm text-neutral-400">Loading…</p>
            ) : linkOptions.length === 0 ? (
              <p className="text-sm text-neutral-400">{linkKind === 'job' ? 'No vehicles on the Work Board right now.' : 'No inventory vehicles found.'}</p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-neutral-200 p-1">
                <button onClick={() => { setLinkId(null); setLinkLabel(null) }}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm ${linkId === null ? 'bg-neutral-900 text-white' : 'bg-white'}`}>None / not vehicle-specific</button>
                {linkOptions.map((o) => (
                  <button key={o.id} onClick={() => { setLinkId(o.id); setLinkLabel(o.label) }}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${linkId === o.id ? 'bg-neutral-900 text-white' : 'bg-white'}`}>
                    <div className="font-medium">{o.label}</div>
                    {o.sub && <div className={`text-xs ${linkId === o.id ? 'text-neutral-300' : 'text-neutral-500'}`}>{o.sub}</div>}
                  </button>
                ))}
              </div>
            )}
          </Field>
        )}

        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <button disabled={busy} onClick={goReview} className="w-full rounded-xl bg-neutral-900 py-4 text-lg font-semibold text-white disabled:opacity-50">{busy ? 'Checking…' : 'Review →'}</button>

        <div className="pt-2">
          <button disabled={busy} onClick={sendTestToShopPrinter} className="block w-full rounded-xl border border-dashed border-neutral-400 py-3 text-center text-sm font-medium text-neutral-600 disabled:opacity-50">Send VOID test page to shop printer (no check recorded)</button>
          <a href="/checks/print?test=1" className="block w-full py-2 text-center text-xs text-neutral-400">or preview/print on this device</a>
        </div>
        {jobStatus && <p className="rounded-lg bg-neutral-100 p-2 text-center text-sm text-neutral-700">Printer: {jobStatus}</p>}

        {props.recent.length > 0 && (
          <div className="pt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-neutral-400">Recent checks</p>
              <a href="/checks/history" className="text-xs font-medium text-neutral-600 underline">Full history →</a>
            </div>
            <div className="divide-y divide-neutral-100 rounded-xl border border-neutral-200">
              {props.recent.map((c) => (
                <div key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <a href={`/checks/${c.id}`} className="min-w-0">
                    <span className="font-medium">#{c.checkNumber}</span> · {c.payeeName}
                    <div className="text-xs text-neutral-500">{c.categoryLabel} · {c.qbStatus}{c.printStatus !== 'not_printed' ? ` · ${c.printStatus}` : ''}</div>
                  </a>
                  <div className="flex items-center gap-2">
                    <span className="tabular-nums">{fmt(c.amountCents)}</span>
                    {c.qbStatus === 'recorded' && <button onClick={() => sendToShopPrinter(c.id, true)} className="rounded border border-neutral-300 px-2 py-1 text-xs">Reprint</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
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
        if (data.status === 'printed') { setJobStatus('test page printed ✓'); return }
        if (data.status === 'failed') { setJobStatus(`test print failed: ${data.error || 'unknown'}`); return }
        setJobStatus(data.status === 'claimed' ? 'printing test page…' : 'test page queued…')
        pollTestJob(jobId, tries + 1)
      } catch { pollTestJob(jobId, tries + 1) }
    }, 2000)
  }

  async function sendToShopPrinter(checkId: string, reprint: boolean) {
    setBusy(true); setError(null); setJobStatus('queuing…')
    try {
      const res = await fetch(`/api/checks/${checkId}/queue-print`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reprint }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Could not queue the check.')
      setJobStatus('queued — waiting for shop printer…')
      pollJob(checkId, data.jobId)
    } catch (e) { setError(String((e as Error).message)); setJobStatus(null) } finally { setBusy(false) }
  }

  function pollJob(checkId: string, jobId: string, tries = 0) {
    if (tries > 40) { setJobStatus('still queued — check the shop printer/bridge.'); return }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/checks/${checkId}/jobs`)
        const data = await res.json()
        const job = (data.jobs || []).find((j: { id: string }) => j.id === jobId)
        if (job?.status === 'printed') { setJobStatus('printed ✓'); return }
        if (job?.status === 'failed') { setJobStatus(`print failed: ${job.error || 'unknown'} — you can resend.`); return }
        setJobStatus(job?.status === 'claimed' ? 'printing…' : `queued (${data.queueDepth} ahead)…`)
        pollJob(checkId, jobId, tries + 1)
      } catch { pollJob(checkId, jobId, tries + 1) }
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
    setPreview(null); setChosenVendorId(null); setConfirmCreate(false); setIdemKey(''); setResult(null); setError(null); setStep('form')
  }
}

function Shell({ actorName, children }: { actorName: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-md bg-neutral-50 px-4 pb-16 pt-6">
      <header className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-bold">Write a Check</h1>
        <span className="text-xs text-neutral-500">{actorName}</span>
      </header>
      {children}
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-sm font-medium text-neutral-700">{label}</label>{children}</div>
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-4"><dt className="text-neutral-500">{label}</dt><dd className="text-right">{children}</dd></div>
}
