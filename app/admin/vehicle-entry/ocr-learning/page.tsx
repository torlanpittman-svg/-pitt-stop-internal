import { Fragment } from 'react'
import Link from 'next/link'
import { getDb } from '@/platform/db'
import { vehicleEntries, ocrPromptResults } from '@/apps/vehicle-entry/schema'
import { desc, isNotNull, and, eq } from 'drizzle-orm'
import OcrLearningClient from './OcrLearningClient'

export const dynamic = 'force-dynamic'

// ── Types ─────────────────────────────────────────────────────────────────────

type EntryRow = {
  id:                      string
  createdAt:               Date
  dealershipName:          string | null
  photoUrl:                string
  originalPhotoUrl:        string | null
  stockNumberCropUrl:      string | null
  // AI originals
  aiYear:                  string | null
  aiMake:                  string | null
  aiModel:                 string | null
  aiColor:                 string | null
  stockNumberAiPrediction: string | null
  // Confirmed values
  year:                    string | null
  make:                    string | null
  model:                   string | null
  color:                   string | null
  stockNumber:             string | null
  // Meta
  ocrConfidence:           Record<string, number> | null
  wasCorrected:            boolean
  promptVersion:           string | null
  modelName:               string | null
}

// ── Char-level diff ───────────────────────────────────────────────────────────

type CharDiff = { ai: string; final: string; changed: boolean }[]

function charDiff(ai: string, final: string): CharDiff {
  if (ai === final) return ai.split('').map(c => ({ ai: c, final: c, changed: false }))

  // For short strings (stock numbers), use simple LCS alignment
  const m = ai.length, n = final.length
  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = ai[i - 1] === final[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  // Backtrack to build alignment
  const result: CharDiff = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ai[i - 1] === final[j - 1]) {
      result.unshift({ ai: ai[i - 1], final: final[j - 1], changed: false })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ ai: ' ', final: final[j - 1], changed: true })
      j--
    } else {
      result.unshift({ ai: ai[i - 1], final: ' ', changed: true })
      i--
    }
  }
  return result
}

// ── Accuracy helpers ──────────────────────────────────────────────────────────

type FieldKey = 'year' | 'make' | 'model' | 'color' | 'stock'

function fieldAccuracy(entries: EntryRow[]): Record<FieldKey, { match: number; total: number }> {
  const acc: Record<FieldKey, { match: number; total: number }> = {
    year:  { match: 0, total: 0 },
    make:  { match: 0, total: 0 },
    model: { match: 0, total: 0 },
    color: { match: 0, total: 0 },
    stock: { match: 0, total: 0 },
  }
  for (const e of entries) {
    const pairs: [string | null, string | null, FieldKey][] = [
      [e.aiYear,   e.year,        'year'],
      [e.aiMake,   e.make,        'make'],
      [e.aiModel,  e.model,       'model'],
      [e.aiColor,  e.color,       'color'],
      [e.stockNumberAiPrediction, e.stockNumber, 'stock'],
    ]
    for (const [ai, confirmed, key] of pairs) {
      if (ai === null || confirmed === null) continue
      acc[key].total++
      if (ai.trim().toLowerCase() === confirmed.trim().toLowerCase()) acc[key].match++
    }
  }
  return acc
}

function pct(n: number, d: number): string {
  if (d === 0) return '—'
  return `${Math.round((n / d) * 100)}%`
}

// Track character substitutions in stock numbers
type SubMap = Map<string, number>
function charSubs(entries: EntryRow[]): [string, string, number][] {
  const counts: SubMap = new Map()
  for (const e of entries) {
    const ai = e.stockNumberAiPrediction
    const final = e.stockNumber
    if (!ai || !final || ai === final) continue
    const diff = charDiff(ai, final)
    for (const d of diff) {
      if (d.changed && d.ai !== ' ' && d.final !== ' ') {
        const key = `${d.ai}→${d.final}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .map(([k, n]) => [k.split('→')[0], k.split('→')[1], n] as [string, string, number])
    .sort((a, b) => b[2] - a[2])
    .slice(0, 20)
}

// ── Page ──────────────────────────────────────────────────────────────────────

const FILTER_OPTIONS = [
  { label: 'All',        value: 'all' },
  { label: 'Production', value: 'production' },
  { label: 'Pilot',      value: 'pilot' },
  { label: 'Test',       value: 'test' },
]

export default async function OcrLearningPage({
  searchParams,
}: {
  searchParams: Promise<{ dt?: string }>
}) {
  const { dt } = await searchParams
  const activeFilter = FILTER_OPTIONS.some(o => o.value === dt) ? dt! : 'all'

  const db = getDb()

  const whereClause = activeFilter === 'all'
    ? isNotNull(vehicleEntries.aiYear)
    : and(isNotNull(vehicleEntries.aiYear), eq(vehicleEntries.dataType, activeFilter))

  const rows = await db
    .select({
      id:                      vehicleEntries.id,
      createdAt:               vehicleEntries.createdAt,
      dealershipName:          vehicleEntries.dealershipName,
      photoUrl:                vehicleEntries.photoUrl,
      originalPhotoUrl:        vehicleEntries.originalPhotoUrl,
      stockNumberCropUrl:      vehicleEntries.stockNumberCropUrl,
      aiYear:                  vehicleEntries.aiYear,
      aiMake:                  vehicleEntries.aiMake,
      aiModel:                 vehicleEntries.aiModel,
      aiColor:                 vehicleEntries.aiColor,
      stockNumberAiPrediction: vehicleEntries.stockNumberAiPrediction,
      year:                    vehicleEntries.year,
      make:                    vehicleEntries.make,
      model:                   vehicleEntries.model,
      color:                   vehicleEntries.color,
      stockNumber:             vehicleEntries.stockNumber,
      ocrConfidence:           vehicleEntries.ocrConfidence,
      wasCorrected:            vehicleEntries.wasCorrected,
      promptVersion:           vehicleEntries.promptVersion,
      modelName:               vehicleEntries.modelName,
    })
    .from(vehicleEntries)
    .where(whereClause)
    .orderBy(desc(vehicleEntries.createdAt))

  const allRows = rows as EntryRow[]

  // Re-run results for comparison
  const rerunRows = await db
    .select()
    .from(ocrPromptResults)
    .orderBy(desc(ocrPromptResults.processedAt))

  const acc     = fieldAccuracy(allRows)
  const subs    = charSubs(allRows)
  const corrected = allRows.filter(e => e.wasCorrected).length
  const total   = allRows.length

  // Overall accuracy = all field pairs that match / all field pairs with data
  const overallMatch = Object.values(acc).reduce((s, v) => s + v.match, 0)
  const overallTotal = Object.values(acc).reduce((s, v) => s + v.total, 0)

  // Accuracy by dealership
  const byDealer = new Map<string, { match: number; total: number }>()
  for (const e of allRows) {
    const d = e.dealershipName ?? 'Unknown'
    if (!byDealer.has(d)) byDealer.set(d, { match: 0, total: 0 })
    const slot = byDealer.get(d)!
    const pairs: [string | null, string | null][] = [
      [e.aiYear, e.year], [e.aiMake, e.make], [e.aiModel, e.model],
      [e.aiColor, e.color], [e.stockNumberAiPrediction, e.stockNumber],
    ]
    for (const [ai, confirmed] of pairs) {
      if (ai === null || confirmed === null) continue
      slot.total++
      if (ai.trim().toLowerCase() === confirmed.trim().toLowerCase()) slot.match++
    }
  }

  // Unique prompt versions
  const promptVersions = [...new Set(allRows.map(e => e.promptVersion).filter(Boolean))]

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm mb-6">
        <Link href="/admin" className="text-gray-500 hover:text-white transition-colors">Admin</Link>
        <span className="text-gray-700">›</span>
        <Link href="/admin/vehicle-entry" className="text-gray-500 hover:text-white transition-colors">Vehicle Entries</Link>
        <span className="text-gray-700">›</span>
        <span className="text-gray-300">OCR Learning</span>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">OCR Learning</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {total} scan{total !== 1 ? 's' : ''} with training data ·{' '}
            {corrected} correction{corrected !== 1 ? 's' : ''} ·{' '}
            {promptVersions.length > 0 ? `prompt ${promptVersions.join(', ')}` : 'no prompt version data'}
          </p>
        </div>
      </div>

      {/* ── Data type filter tabs ── */}
      <div className="flex items-center gap-1 mb-8">
        {FILTER_OPTIONS.map(opt => (
          <Link
            key={opt.value}
            href={opt.value === 'all' ? '/admin/vehicle-entry/ocr-learning' : `/admin/vehicle-entry/ocr-learning?dt=${opt.value}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${activeFilter === opt.value
                ? 'bg-gray-700 text-white'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}
          >
            {opt.label}
          </Link>
        ))}
        {activeFilter !== 'all' && (
          <span className="ml-2 text-gray-600 text-xs">
            Showing {activeFilter} records only · Accuracy metrics calculated on this subset
          </span>
        )}
      </div>

      {total === 0 ? (
        <div className="bg-gray-800 border border-gray-700 rounded-2xl px-6 py-16 text-center">
          <p className="text-gray-400 text-lg font-medium">No training data yet</p>
          <p className="text-gray-600 text-sm mt-2">
            Complete a scan to generate the first training record.
          </p>
        </div>
      ) : (
        <div className="space-y-8">

          {/* ── ACCURACY METRICS ───────────────────────────────────────── */}
          <section>
            <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Accuracy Metrics</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {([
                ['Overall',      overallMatch, overallTotal],
                ['Year',         acc.year.match,  acc.year.total],
                ['Make',         acc.make.match,  acc.make.total],
                ['Model',        acc.model.match, acc.model.total],
                ['Color',        acc.color.match, acc.color.total],
                ['Stock #',      acc.stock.match, acc.stock.total],
              ] as [string, number, number][]).map(([label, m, t]) => {
                const p = t === 0 ? null : Math.round((m / t) * 100)
                const color = p === null ? 'text-gray-500' : p >= 95 ? 'text-green-400' : p >= 80 ? 'text-yellow-400' : 'text-red-400'
                return (
                  <div key={label} className="bg-gray-900 rounded-2xl p-4 text-center">
                    <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">{label}</div>
                    <div className={`text-2xl font-bold tabular-nums ${color}`}>
                      {pct(m, t)}
                    </div>
                    <div className="text-gray-600 text-xs mt-1">{m}/{t} exact</div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* ── BY DEALERSHIP ─────────────────────────────────────────── */}
          {byDealer.size > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Accuracy by Dealership</h2>
              <div className="bg-gray-900 rounded-2xl px-5 divide-y divide-gray-800">
                {[...byDealer.entries()].map(([dealer, { match: m, total: t }]) => (
                  <div key={dealer} className="flex items-center justify-between py-3">
                    <span className="text-gray-300 text-sm">{dealer}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-gray-600 text-xs">{m}/{t} fields</span>
                      <span className={`text-sm font-bold tabular-nums ${t === 0 ? 'text-gray-500' : Math.round((m/t)*100) >= 95 ? 'text-green-400' : Math.round((m/t)*100) >= 80 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {pct(m, t)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── CHARACTER SUBSTITUTIONS ───────────────────────────────── */}
          {subs.length > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Common Character Corrections (stock #)</h2>
              <div className="bg-gray-900 rounded-2xl p-5">
                <div className="grid grid-cols-[auto_auto_1fr_auto] gap-x-4 gap-y-2 items-center text-sm">
                  {subs.map(([ai, final, count]) => (
                    <Fragment key={`${ai}-${final}`}>
                      <span className="text-red-400 font-mono font-bold text-lg">{ai}</span>
                      <span className="text-gray-600">→</span>
                      <span className="text-green-400 font-mono font-bold text-lg">{final}</span>
                      <span className="text-gray-500 text-xs text-right">{count}×</span>
                    </Fragment>
                  ))}
                </div>
                <p className="text-gray-600 text-xs mt-4">
                  These are the characters the AI got wrong most often. Use them to improve the prompt or add normalization rules.
                </p>
              </div>
            </section>
          )}

          {/* ── RE-RUN DATASET ────────────────────────────────────────── */}
          <OcrLearningClient
            entryIds={allRows.map(e => e.id)}
            rerunCount={rerunRows.length}
          />

          {/* ── ENTRY LIST ────────────────────────────────────────────── */}
          <section>
            <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">
              All Scans with Training Data
            </h2>
            <div className="space-y-3">
              {allRows.map(e => {
                const conf = (e.ocrConfidence ?? {}) as Record<string, number>
                const stockDiff = e.stockNumberAiPrediction && e.stockNumber
                  ? charDiff(e.stockNumberAiPrediction, e.stockNumber)
                  : null

                const fields: { label: string; ai: string | null; final: string | null; conf: number | null }[] = [
                  { label: 'Year',    ai: e.aiYear,  final: e.year,        conf: conf.year   ?? null },
                  { label: 'Make',    ai: e.aiMake,  final: e.make,        conf: conf.make   ?? null },
                  { label: 'Model',   ai: e.aiModel, final: e.model,       conf: conf.model  ?? null },
                  { label: 'Color',   ai: e.aiColor, final: e.color,       conf: conf.color  ?? null },
                  { label: 'Stock #', ai: e.stockNumberAiPrediction, final: e.stockNumber, conf: conf.stockNumber ?? null },
                ]

                return (
                  <div key={e.id} className="bg-gray-900 rounded-2xl overflow-hidden">
                    <div className="flex gap-4 p-4">
                      {/* Photo thumbnail */}
                      <div className="flex-shrink-0 w-20 h-20 bg-gray-800 rounded-xl overflow-hidden">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={e.stockNumberCropUrl ?? e.photoUrl}
                          alt="Tag"
                          className="w-full h-full object-cover"
                        />
                      </div>

                      {/* Meta */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="text-gray-400 text-xs">
                            {new Date(e.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </span>
                          {e.dealershipName && (
                            <span className="text-xs bg-gray-800 text-gray-400 rounded px-2 py-0.5">{e.dealershipName}</span>
                          )}
                          {e.promptVersion && (
                            <span className="text-xs bg-blue-950 text-blue-400 rounded px-2 py-0.5 font-mono">{e.promptVersion}</span>
                          )}
                          {e.modelName && (
                            <span className="text-xs bg-gray-800 text-gray-500 rounded px-2 py-0.5 font-mono">{e.modelName}</span>
                          )}
                          {e.wasCorrected ? (
                            <span className="text-xs bg-yellow-950 text-yellow-400 rounded px-2 py-0.5">corrected</span>
                          ) : (
                            <span className="text-xs bg-green-950 text-green-600 rounded px-2 py-0.5">accepted as-is</span>
                          )}
                        </div>

                        {/* Field table */}
                        <div className="grid grid-cols-[4rem_1fr_1fr_3rem] gap-x-3 gap-y-1 text-xs">
                          <span className="text-gray-600 uppercase tracking-wide font-semibold col-span-1"></span>
                          <span className="text-gray-600 uppercase tracking-wide">AI said</span>
                          <span className="text-gray-600 uppercase tracking-wide">Confirmed</span>
                          <span className="text-gray-600 uppercase tracking-wide text-right">Conf</span>

                          {fields.map(f => {
                            const changed = f.ai !== null && f.final !== null &&
                              f.ai.trim().toLowerCase() !== f.final.trim().toLowerCase()
                            return (
                              <Fragment key={f.label}>
                                <span className="text-gray-500">{f.label}</span>
                                <span className={`font-mono ${changed ? 'text-red-400' : 'text-gray-300'}`}>
                                  {f.ai ?? <span className="text-gray-700">—</span>}
                                </span>
                                <span className={`font-mono ${changed ? 'text-green-400 font-bold' : 'text-gray-300'}`}>
                                  {f.final ?? <span className="text-gray-700">—</span>}
                                </span>
                                <span className="text-gray-600 text-right tabular-nums">
                                  {f.conf !== null ? `${Math.round(f.conf * 100)}%` : '—'}
                                </span>
                              </Fragment>
                            )
                          })}
                        </div>

                        {/* Stock number character-level diff */}
                        {stockDiff && e.stockNumberAiPrediction !== e.stockNumber && (
                          <div className="mt-3 space-y-1 font-mono text-sm">
                            <div className="flex items-center gap-1">
                              <span className="text-gray-600 text-xs mr-1 w-16">AI said:</span>
                              {stockDiff.map((d, i) => (
                                <span key={i} className={d.changed ? 'bg-red-950/60 text-red-300 rounded px-0.5 border border-red-800' : 'text-gray-400'}>
                                  {d.ai === ' ' ? '' : d.ai}
                                </span>
                              ))}
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-gray-600 text-xs mr-1 w-16">Confirmed:</span>
                              {stockDiff.map((d, i) => (
                                <span key={i} className={d.changed ? 'bg-green-950/60 text-green-300 rounded px-0.5 border border-green-800' : 'text-gray-400'}>
                                  {d.final === ' ' ? '' : d.final}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Link to full entry */}
                      <Link
                        href={`/admin/vehicle-entry/${e.id}`}
                        className="flex-shrink-0 text-gray-600 hover:text-gray-300 transition-colors text-lg self-center"
                      >
                        ›
                      </Link>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
