'use client'
/** Opening-Inventory Backfill review UI. Paste the spreadsheet (TSV/CSV) → Preview (dry-run match) →
 *  review/correct each row → Confirm selected. Nothing is created until you commit; historical costs
 *  are never fabricated. */
import { useState } from 'react'
import { previewBackfillAction, commitBackfillAction } from './actions'
import type { BackfillPreview } from '@/apps/auto-sales/db'

type Row = BackfillPreview & { confirm: boolean }
const HEADERS: Record<string, keyof BackfillPreview> = {
  year: 'year', make: 'make', model: 'model', color: 'color',
  vin: 'partialVin', partialvin: 'partialVin', 'partial_vin': 'partialVin',
  cost: 'acquisitionCost', acquisitioncost: 'acquisitionCost', 'acquisition_cost': 'acquisitionCost', price: 'acquisitionCost',
  date: 'acquisitionDate', acquisitiondate: 'acquisitionDate', 'acquisition_date': 'acquisitionDate',
  days: 'daysOnLot', daysonlot: 'daysOnLot', 'days_on_lot': 'daysOnLot',
}

function parse(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []
  const delim = lines[0].includes('\t') ? '\t' : ','
  const head = lines[0].split(delim).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  return lines.slice(1).map((line) => {
    const cells = line.split(delim)
    const row: Record<string, string> = {}
    head.forEach((h, i) => { const key = HEADERS[h] ?? HEADERS[h.replace(/_/g, '')]; if (key) row[key] = (cells[i] ?? '').trim() })
    return row
  })
}

const money = (c: number | null) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
const input = 'bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white w-full'

export default function BackfillClient() {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null)

  async function preview() {
    setBusy(true); setResult(null)
    const parsed = parse(text)
    const pv = await previewBackfillAction(parsed)
    setRows(pv.map((p) => ({ ...p, confirm: p.missing.length === 0 })))
    setBusy(false)
  }
  async function commit() {
    if (!rows) return
    setBusy(true)
    const res = await commitBackfillAction(rows.map((r) => ({ year: r.year, make: r.make, model: r.model, color: r.color, partialVin: r.partialVin, acquisitionCost: r.acquisitionCost, acquisitionDate: r.acquisitionDate, confirm: r.confirm })))
    setResult(res); setRows(null); setText(''); setBusy(false)
  }
  function edit(i: number, k: keyof Row, v: string | boolean) { setRows((rs) => rs!.map((r, j) => j === i ? { ...r, [k]: v } : r)) }

  return (
    <div>
      {result && <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/15 px-4 py-3 mb-4 text-emerald-300 text-sm">Imported {result.created} vehicle(s); skipped {result.skipped} (unconfirmed or missing cost/date).</div>}
      {!rows && (<>
        <p className="text-gray-500 text-xs mb-2">Paste your inventory spreadsheet (TSV or CSV, with a header row). Recognized columns: year, make, model, color, vin/partial_vin, acquisition_cost, acquisition_date (YYYY-MM-DD), days_on_lot.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={'year\tmake\tmodel\tpartial_vin\tcolor\tacquisition_cost\tacquisition_date\ndays...'} className="w-full bg-gray-800 border border-gray-700 rounded-lg p-3 text-xs text-white font-mono" />
        <button onClick={preview} disabled={busy || !text.trim()} className="mt-3 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-50">{busy ? 'Matching…' : 'Preview & match'}</button>
      </>)}

      {rows && (<>
        <p className="text-gray-500 text-xs mb-2">Review each row. A <b>full 17-char VIN</b> matches the canonical vehicle and yields a PS stock number; a partial VIN stays <b>Needs review</b> (no fabricated identity). Correct cost/date/VIN as needed, then confirm. Nothing is created until you commit.</p>
        <table className="w-full text-xs">
          <thead><tr className="text-gray-600 uppercase tracking-wider"><th className="text-left py-1">✓</th><th className="text-left py-1">Vehicle</th><th className="text-left py-1">VIN</th><th className="text-left py-1">Match</th><th className="text-left py-1">Stock</th><th className="text-right py-1">Cost</th><th className="text-left py-1">Date</th><th className="text-left py-1">Missing</th><th className="text-left py-1">Completeness</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-gray-800/60 align-top">
                <td className="py-1.5"><input type="checkbox" checked={r.confirm} onChange={(e) => edit(i, 'confirm', e.target.checked)} /></td>
                <td className="py-1.5 text-gray-300">{[r.year, r.make, r.model, r.color].filter(Boolean).join(' ') || '—'}</td>
                <td className="py-1.5"><input value={r.partialVin ?? ''} onChange={(e) => edit(i, 'partialVin', e.target.value)} className={input} style={{ width: 150 }} /></td>
                <td className="py-1.5">{r.matchedVehicleId ? <span className="text-emerald-300">✓ full VIN</span> : r.vinConfidence === 'partial_only' ? <span className="text-amber-400">partial</span> : <span className="text-gray-500">none</span>}</td>
                <td className="py-1.5 text-gray-400">{r.proposedStock ?? '—'}</td>
                <td className="py-1.5 text-right"><input value={r.acquisitionCost ?? ''} onChange={(e) => edit(i, 'acquisitionCost', e.target.value)} className={input} style={{ width: 80 }} /></td>
                <td className="py-1.5"><input value={r.acquisitionDate ?? ''} onChange={(e) => edit(i, 'acquisitionDate', e.target.value)} placeholder="YYYY-MM-DD" className={input} style={{ width: 110 }} /></td>
                <td className="py-1.5 text-amber-400/80">{r.missing.join(', ') || '—'}</td>
                <td className="py-1.5"><span className={r.matchedVehicleId ? 'text-amber-300' : 'text-red-300'}>{r.matchedVehicleId ? 'Historical incomplete' : 'Needs review'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-2 mt-3">
          <button onClick={commit} disabled={busy} className="bg-green-600 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-50">{busy ? 'Importing…' : `Import ${rows.filter((r) => r.confirm).length} confirmed`}</button>
          <button onClick={() => setRows(null)} className="text-gray-400 text-sm px-4 py-2">Back</button>
        </div>
      </>)}
    </div>
  )
}
