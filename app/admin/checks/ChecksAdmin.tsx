'use client'
/**
 * Owner setup for Write-a-Check. Picks the operating (*2649) + Auto Sales (*5600) bank accounts and each
 * business-category → QuickBooks expense account from the LIVE company (never typed/guessed), sets the
 * starting physical check number per bank, tunes print calibration, and flips the feature on. Fail-safe:
 * the everyday /checks form stays blocked until this reports "ready".
 */
import { useCallback, useEffect, useState } from 'react'

type QbAccount = { id: string; name: string; type: string; subType: string | null; acctNumMask: string | null; active: boolean }
type Cat = { key: string; label: string; entity: string; hint: string }
type Readiness = { ready: boolean; enabled: boolean; operatingBankConfigured: boolean; autoSalesBankConfigured: boolean; missingCategoryAccounts: string[] }
type Config = {
  enabled: boolean
  banks: Record<'operating' | 'auto_sales', { key: string; qboAccountId: string; label: string }>
  categoryAccounts: Record<string, string>
  layout: { position: string; offsetX: number; offsetY: number; fields: string[] }
}

async function jget(url: string) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `GET ${url} failed`); return r.json() }
async function jpost(url: string, body: unknown) { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.message || `POST ${url} failed`); return d }

export default function ChecksAdmin() {
  const [config, setConfig] = useState<Config | null>(null)
  const [categories, setCategories] = useState<Cat[]>([])
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [sequences, setSequences] = useState<{ operating: number | null; auto_sales: number | null }>({ operating: null, auto_sales: null })
  const [banks, setBanks] = useState<QbAccount[]>([])
  const [expenses, setExpenses] = useState<QbAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // form state
  const [enabled, setEnabled] = useState(false)
  const [opBank, setOpBank] = useState('')
  const [asBank, setAsBank] = useState('')
  const [catMap, setCatMap] = useState<Record<string, string>>({})
  const [offsetX, setOffsetX] = useState('0')
  const [offsetY, setOffsetY] = useState('0')
  const [position, setPosition] = useState('top')
  const [opStart, setOpStart] = useState('')
  const [asStart, setAsStart] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const s = await jget('/api/admin/checks/setup')
      setConfig(s.config); setCategories(s.categories); setReadiness(s.readiness); setSequences(s.sequences)
      setEnabled(s.config.enabled); setOpBank(s.config.banks.operating.qboAccountId); setAsBank(s.config.banks.auto_sales.qboAccountId)
      setCatMap(s.config.categoryAccounts || {})
      setOffsetX(String(s.config.layout.offsetX ?? 0)); setOffsetY(String(s.config.layout.offsetY ?? 0)); setPosition(s.config.layout.position ?? 'top')
    } catch (e) { setErr(String((e as Error).message)) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function loadAccounts() {
    setErr(null); setMsg('Loading accounts from QuickBooks…')
    try {
      const [b, x] = await Promise.all([jget('/api/admin/checks/accounts?type=Bank'), jget('/api/admin/checks/accounts?type=Expense')])
      setBanks(b.accounts); setExpenses(x.accounts); setMsg(`Loaded ${b.accounts.length} bank + ${x.accounts.length} expense accounts.`)
    } catch (e) { setErr(String((e as Error).message)); setMsg(null) }
  }

  async function save() {
    setErr(null); setMsg('Saving…')
    try {
      const res = await jpost('/api/admin/checks/setup', {
        enabled, operatingBankQboId: opBank, autoSalesBankQboId: asBank,
        categoryAccounts: catMap,
        layout: { position, offsetX: parseFloat(offsetX) || 0, offsetY: parseFloat(offsetY) || 0 },
      })
      setReadiness(res.readiness); setConfig(res.config); setMsg('Saved ✓')
    } catch (e) { setErr(String((e as Error).message)); setMsg(null) }
  }

  async function saveSequence(bankKey: 'operating' | 'auto_sales', value: string) {
    setErr(null)
    const startNumber = parseInt(value, 10)
    if (!Number.isInteger(startNumber) || startNumber <= 0) return setErr('Enter a positive starting check number.')
    try {
      await jpost('/api/admin/checks/sequence', { bankKey, startNumber })
      setMsg(`${bankKey} sequence set to ${startNumber} ✓`)
      const s = await jget('/api/admin/checks/setup'); setSequences(s.sequences)
    } catch (e) { setErr(String((e as Error).message)) }
  }

  if (loading) return <div className="p-6 text-neutral-500">Loading…</div>

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Checks — Setup</h1>
        <a href="/checks" className="text-sm text-blue-600">Open Write a Check →</a>
      </div>

      {readiness && (
        <div className={`rounded-lg p-3 text-sm ${readiness.ready ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
          {readiness.ready ? 'Ready — managers can write checks.' : 'Not ready yet. Complete the steps below.'}
          {readiness.missingCategoryAccounts.length > 0 && <div className="mt-1">Unmapped categories: {readiness.missingCategoryAccounts.join(', ')}</div>}
        </div>
      )}
      {err && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</div>}
      {msg && <div className="rounded-lg bg-neutral-100 p-3 text-sm text-neutral-700">{msg}</div>}

      <button onClick={loadAccounts} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium">Load QuickBooks accounts</button>

      {/* Bank accounts */}
      <section className="space-y-3 rounded-xl border border-neutral-200 p-4">
        <h2 className="font-semibold">Bank accounts (which account the money leaves)</h2>
        <AccountSelect label="Operating — Pitt Stop *2649" value={opBank} onChange={setOpBank} accounts={banks} placeholder={config?.banks.operating.qboAccountId ? `saved: ${config.banks.operating.qboAccountId}` : 'Load accounts, then pick'} />
        <AccountSelect label="Auto Sales *5600 (optional — kept separate)" value={asBank} onChange={setAsBank} accounts={banks} placeholder={config?.banks.auto_sales.qboAccountId ? `saved: ${config.banks.auto_sales.qboAccountId}` : 'Optional'} />
      </section>

      {/* Category → expense account */}
      <section className="space-y-3 rounded-xl border border-neutral-200 p-4">
        <h2 className="font-semibold">Category → expense account</h2>
        {categories.map((c) => (
          <AccountSelect key={c.key} label={`${c.label}`} value={catMap[c.key] || ''} onChange={(v) => setCatMap((m) => ({ ...m, [c.key]: v }))} accounts={expenses} placeholder={catMap[c.key] ? `saved: ${catMap[c.key]}` : 'Pick expense account'} />
        ))}
      </section>

      {/* Check numbers */}
      <section className="space-y-3 rounded-xl border border-neutral-200 p-4">
        <h2 className="font-semibold">Starting check number (next blank check in the tray)</h2>
        <SeqRow label="Operating" current={sequences.operating} value={opStart} setValue={setOpStart} onSave={() => saveSequence('operating', opStart)} />
        <SeqRow label="Auto Sales" current={sequences.auto_sales} value={asStart} setValue={setAsStart} onSave={() => saveSequence('auto_sales', asStart)} />
        <p className="text-xs text-neutral-500">Set this to the number printed on the next blank check. The system will not let two checks share a number.</p>
      </section>

      {/* Calibration */}
      <section className="space-y-3 rounded-xl border border-neutral-200 p-4">
        <h2 className="font-semibold">Print calibration</h2>
        <div className="grid grid-cols-3 gap-3">
          <label className="text-sm">Position
            <select value={position} onChange={(e) => setPosition(e.target.value)} className="mt-1 w-full rounded border px-2 py-1">
              <option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option>
            </select>
          </label>
          <label className="text-sm">X offset (in)<input value={offsetX} onChange={(e) => setOffsetX(e.target.value)} className="mt-1 w-full rounded border px-2 py-1" /></label>
          <label className="text-sm">Y offset (in)<input value={offsetY} onChange={(e) => setOffsetY(e.target.value)} className="mt-1 w-full rounded border px-2 py-1" /></label>
        </div>
        <div className="flex gap-2">
          <a href={`/checks/print?test=1&offx=${encodeURIComponent(offsetX)}&offy=${encodeURIComponent(offsetY)}&pos=${position}`} target="_blank" className="rounded-lg border border-neutral-300 px-3 py-2 text-sm">Test print with these offsets ↗</a>
        </div>
        <p className="text-xs text-neutral-500">Positive X = right, positive Y = down. Tune against a plain-paper test held behind the check, then Save.</p>
      </section>

      {/* Enable + save */}
      <section className="space-y-3 rounded-xl border border-neutral-200 p-4">
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <span className="font-medium">Enable check writing</span></label>
        <button onClick={save} className="w-full rounded-xl bg-neutral-900 py-3 font-semibold text-white">Save setup</button>
      </section>
    </div>
  )
}

function AccountSelect({ label, value, onChange, accounts, placeholder }: { label: string; value: string; onChange: (v: string) => void; accounts: QbAccount[]; placeholder: string }) {
  return (
    <label className="block text-sm">
      <span className="text-neutral-700">{label}</span>
      {accounts.length > 0 ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded border px-2 py-2">
          <option value="">— none —</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.acctNumMask ? ` (${a.acctNumMask})` : ''} · #{a.id}</option>)}
        </select>
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="mt-1 w-full rounded border px-2 py-2" />
      )}
    </label>
  )
}

function SeqRow({ label, current, value, setValue, onSave }: { label: string; current: number | null; value: string; setValue: (v: string) => void; onSave: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 text-sm text-neutral-700">{label}</span>
      <span className="text-sm text-neutral-500">next: {current ?? '—'}</span>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="start #" inputMode="numeric" className="w-28 rounded border px-2 py-1" />
      <button onClick={onSave} className="rounded border border-neutral-300 px-3 py-1 text-sm">Set</button>
    </div>
  )
}
