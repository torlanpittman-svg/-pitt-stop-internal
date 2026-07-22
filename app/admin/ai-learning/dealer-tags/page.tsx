import { Fragment } from 'react'
import Link from 'next/link'
import { getDb } from '@/platform/db'
import { vehicleEntries, ocrPromptResults } from '@/apps/vehicle-entry/schema'
import { desc, isNotNull, eq, and } from 'drizzle-orm'
import ReplayTool from './ReplayTool'
import type { NormalizationChange } from '@/apps/ai-learning/normalizations'
import { RULE_LABELS } from '@/apps/ai-learning/normalizations'

export const dynamic = 'force-dynamic'

// ── Types ─────────────────────────────────────────────────────────────────────

type EntryRow = {
  id:                      string
  createdAt:               Date
  dealershipName:          string | null
  photoUrl:                string
  originalPhotoUrl:        string | null
  stockNumberCropUrl:      string | null
  // Original AI predictions (frozen at scan time)
  aiYear:                  string | null
  aiMake:                  string | null
  aiModel:                 string | null
  aiColor:                 string | null
  stockNumberAiPrediction: string | null
  stockRawOcr:             string | null
  normalizationsApplied:   unknown
  detectedStockPrefix:     string | null
  expectedDealerPrefix:    string | null
  // Employee-confirmed values
  year:                    string | null
  make:                    string | null
  model:                   string | null
  color:                   string | null
  stockNumber:             string | null
  // Correction flags
  ocrConfidence:           Record<string, number> | null
  wasCorrected:            boolean
  yearWasCorrected:        boolean
  makeWasCorrected:        boolean
  modelWasCorrected:       boolean
  colorWasCorrected:       boolean
  stockWasCorrected:       boolean
  promptVersion:           string | null
  modelName:               string | null
}

// ── Char-level diff ───────────────────────────────────────────────────────────

type CharDiff = { ai: string; final: string; changed: boolean }[]

function charDiff(ai: string, final: string): CharDiff {
  if (ai === final) return ai.split('').map(c => ({ ai: c, final: c, changed: false }))
  const m = ai.length, n = final.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = ai[i - 1] === final[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
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

type FieldKey = 'year' | 'make' | 'model' | 'color' | 'stock' | 'prefix'

function fieldAccuracy(entries: EntryRow[]): Record<FieldKey, { match: number; total: number }> {
  const acc: Record<FieldKey, { match: number; total: number }> = {
    year:   { match: 0, total: 0 },
    make:   { match: 0, total: 0 },
    model:  { match: 0, total: 0 },
    color:  { match: 0, total: 0 },
    stock:  { match: 0, total: 0 },
    prefix: { match: 0, total: 0 },
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
    // Prefix accuracy (only when expected prefix known)
    if (e.detectedStockPrefix && e.expectedDealerPrefix) {
      acc.prefix.total++
      if (e.detectedStockPrefix.toUpperCase() === e.expectedDealerPrefix.toUpperCase())
        acc.prefix.match++
    }
  }
  return acc
}

function pct(n: number, d: number): string {
  if (d === 0) return '—'
  return `${Math.round((n / d) * 100)}%`
}

function charSubs(entries: EntryRow[]): [string, string, number][] {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const ai = e.stockNumberAiPrediction
    const fin = e.stockNumber
    if (!ai || !fin || ai === fin) continue
    const diff = charDiff(ai, fin)
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

function avgConf(entries: EntryRow[]): Record<string, number | null> {
  const fields = ['year', 'make', 'model', 'color', 'stockNumber']
  const result: Record<string, number | null> = {}
  for (const f of fields) {
    const vals = entries
      .map(e => (e.ocrConfidence?.[f] ?? null))
      .filter((v): v is number => v !== null)
    result[f] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  return result
}

function correctionRate(entries: EntryRow[]): Record<string, { corrected: number; total: number }> {
  const result: Record<string, { corrected: number; total: number }> = {
    year: {corrected:0,total:0}, make: {corrected:0,total:0},
    model:{corrected:0,total:0}, color:{corrected:0,total:0}, stock:{corrected:0,total:0},
  }
  for (const e of entries) {
    // Only count entries that have per-field flags set
    if (e.aiYear !== null) { result.year.total++; if (e.yearWasCorrected) result.year.corrected++ }
    if (e.aiMake !== null) { result.make.total++; if (e.makeWasCorrected) result.make.corrected++ }
    if (e.aiModel !== null) { result.model.total++; if (e.modelWasCorrected) result.model.corrected++ }
    if (e.aiColor !== null) { result.color.total++; if (e.colorWasCorrected) result.color.corrected++ }
    if (e.stockNumberAiPrediction !== null) { result.stock.total++; if (e.stockWasCorrected) result.stock.corrected++ }
  }
  return result
}

function normalizationStats(entries: EntryRow[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const changes = e.normalizationsApplied as NormalizationChange[] | null
    if (!Array.isArray(changes)) continue
    for (const c of changes) {
      counts.set(c.rule, (counts.get(c.rule) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

const FILTER_OPTIONS = [
  { label: 'All',        value: 'all' },
  { label: 'Production', value: 'production' },
  { label: 'Pilot',      value: 'pilot' },
  { label: 'Test',       value: 'test' },
]

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function DealerTagLearningPage({
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
      dataType:                vehicleEntries.dataType,
      photoUrl:                vehicleEntries.photoUrl,
      originalPhotoUrl:        vehicleEntries.originalPhotoUrl,
      stockNumberCropUrl:      vehicleEntries.stockNumberCropUrl,
      aiYear:                  vehicleEntries.aiYear,
      aiMake:                  vehicleEntries.aiMake,
      aiModel:                 vehicleEntries.aiModel,
      aiColor:                 vehicleEntries.aiColor,
      stockNumberAiPrediction: vehicleEntries.stockNumberAiPrediction,
      stockRawOcr:             vehicleEntries.stockRawOcr,
      normalizationsApplied:   vehicleEntries.normalizationsApplied,
      detectedStockPrefix:     vehicleEntries.detectedStockPrefix,
      expectedDealerPrefix:    vehicleEntries.expectedDealerPrefix,
      year:                    vehicleEntries.year,
      make:                    vehicleEntries.make,
      model:                   vehicleEntries.model,
      color:                   vehicleEntries.color,
      stockNumber:             vehicleEntries.stockNumber,
      ocrConfidence:           vehicleEntries.ocrConfidence,
      wasCorrected:            vehicleEntries.wasCorrected,
      yearWasCorrected:        vehicleEntries.yearWasCorrected,
      makeWasCorrected:        vehicleEntries.makeWasCorrected,
      modelWasCorrected:       vehicleEntries.modelWasCorrected,
      colorWasCorrected:       vehicleEntries.colorWasCorrected,
      stockWasCorrected:       vehicleEntries.stockWasCorrected,
      promptVersion:           vehicleEntries.promptVersion,
      modelName:               vehicleEntries.modelName,
    })
    .from(vehicleEntries)
    .where(whereClause)
    .orderBy(desc(vehicleEntries.createdAt))

  const allRows = rows as EntryRow[]

  const rerunRows = await db
    .select()
    .from(ocrPromptResults)
    .orderBy(desc(ocrPromptResults.processedAt))

  const acc       = fieldAccuracy(allRows)
  const subs      = charSubs(allRows)
  const normStats = normalizationStats(allRows)
  const corrRate  = correctionRate(allRows)
  const avgC      = avgConf(allRows)
  const corrected = allRows.filter(e => e.wasCorrected).length
  const total     = allRows.length

  const overallMatch = Object.values(acc).reduce((s, v) => s + v.match, 0)
  const overallTotal = Object.values(acc).reduce((s, v) => s + v.total, 0)

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

  const byPromptVersion = new Map<string, { match: number; total: number }>()
  for (const e of allRows) {
    const v = e.promptVersion ?? 'unknown'
    if (!byPromptVersion.has(v)) byPromptVersion.set(v, { match: 0, total: 0 })
    const slot = byPromptVersion.get(v)!
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

  const byModelName = new Map<string, { match: number; total: number }>()
  for (const e of allRows) {
    const v = e.modelName ?? 'unknown'
    if (!byModelName.has(v)) byModelName.set(v, { match: 0, total: 0 })
    const slot = byModelName.get(v)!
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

  const promptVersions = [...new Set(allRows.map(e => e.promptVersion).filter(Boolean))]

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-sm transition-colors mb-8"
      >
        <span>←</span>
        <span>Back to Admin</span>
      </Link>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Dealer Tag Scanner Learning</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {total} scan{total !== 1 ? 's' : ''} with AI predictions ·{' '}
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
            href={opt.value === 'all' ? '/admin/ai-learning/dealer-tags' : `/admin/ai-learning/dealer-tags?dt=${opt.value}`}
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
          <p className="text-gray-600 text-sm mt-2">Complete a key-tag scan to generate the first record.</p>
        </div>
      ) : (
        <div className="space-y-10">

          {/* ── ACCURACY METRICS ─────────────────────────────────────────── */}
          <section>
            <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Accuracy Metrics</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
              {([
                ['Overall', overallMatch, overallTotal],
                ['Year',    acc.year.match,   acc.year.total],
                ['Make',    acc.make.match,   acc.make.total],
                ['Model',   acc.model.match,  acc.model.total],
                ['Color',   acc.color.match,  acc.color.total],
                ['Stock #', acc.stock.match,  acc.stock.total],
                ['Prefix',  acc.prefix.match, acc.prefix.total],
              ] as [string, number, number][]).map(([label, m, t]) => {
                const p = t === 0 ? null : Math.round((m / t) * 100)
                const clr = p === null ? 'text-gray-500' : p >= 95 ? 'text-green-400' : p >= 80 ? 'text-yellow-400' : 'text-red-400'
                return (
                  <div key={label} className="bg-gray-900 rounded-2xl p-4 text-center">
                    <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">{label}</div>
                    <div className={`text-2xl font-bold tabular-nums ${clr}`}>{pct(m, t)}</div>
                    <div className="text-gray-600 text-xs mt-1">{m}/{t}</div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* ── CORRECTION RATE BY FIELD ─────────────────────────────────── */}
          <section>
            <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Correction Rate by Field</h2>
            <div className="bg-gray-900 rounded-2xl px-5 divide-y divide-gray-800">
              {(['year','make','model','color','stock'] as const).map(f => {
                const { corrected: c, total: t } = corrRate[f]
                const pctVal = t === 0 ? null : Math.round((c / t) * 100)
                const clr = pctVal === null ? 'text-gray-500' : pctVal >= 20 ? 'text-red-400' : pctVal >= 10 ? 'text-yellow-400' : 'text-green-400'
                const avgConf_ = avgC[f === 'stock' ? 'stockNumber' : f]
                return (
                  <div key={f} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-gray-300 text-sm capitalize w-16">{f === 'stock' ? 'Stock #' : f}</span>
                      {avgConf_ !== null && (
                        <span className="text-gray-600 text-xs">avg confidence {Math.round((avgConf_ ?? 0) * 100)}%</span>
                      )}
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="w-32 bg-gray-800 rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${pctVal !== null && pctVal >= 20 ? 'bg-red-500' : pctVal !== null && pctVal >= 10 ? 'bg-yellow-500' : 'bg-green-500'}`}
                          style={{ width: `${pctVal ?? 0}%` }}
                        />
                      </div>
                      <span className={`text-sm font-bold tabular-nums w-12 text-right ${clr}`}>
                        {pct(c, t)}
                      </span>
                      <span className="text-gray-600 text-xs w-16 text-right">{c}/{t} scans</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* ── BY DEALERSHIP ────────────────────────────────────────────── */}
          {byDealer.size > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Accuracy by Dealership</h2>
              <div className="bg-gray-900 rounded-2xl px-5 divide-y divide-gray-800">
                {[...byDealer.entries()].map(([dealer, { match: m, total: t }]) => (
                  <div key={dealer} className="flex items-center justify-between py-3">
                    <span className="text-gray-300 text-sm">{dealer}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-gray-600 text-xs">{m}/{t} fields</span>
                      <span className={`text-sm font-bold tabular-nums w-12 text-right ${t === 0 ? 'text-gray-500' : Math.round((m/t)*100) >= 95 ? 'text-green-400' : Math.round((m/t)*100) >= 80 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {pct(m, t)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── BY PROMPT VERSION ────────────────────────────────────────── */}
          {byPromptVersion.size > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Accuracy by Prompt Version</h2>
              <div className="bg-gray-900 rounded-2xl px-5 divide-y divide-gray-800">
                {[...byPromptVersion.entries()].map(([version, { match: m, total: t }]) => (
                  <div key={version} className="flex items-center justify-between py-3">
                    <span className="text-blue-300 font-mono text-sm">{version}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-gray-600 text-xs">{m}/{t} fields</span>
                      <span className={`text-sm font-bold tabular-nums w-12 text-right ${t === 0 ? 'text-gray-500' : Math.round((m/t)*100) >= 95 ? 'text-green-400' : Math.round((m/t)*100) >= 80 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {pct(m, t)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── BY MODEL VERSION ─────────────────────────────────────────── */}
          {byModelName.size > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">Accuracy by Model Version</h2>
              <div className="bg-gray-900 rounded-2xl px-5 divide-y divide-gray-800">
                {[...byModelName.entries()].map(([model, { match: m, total: t }]) => (
                  <div key={model} className="flex items-center justify-between py-3">
                    <span className="text-gray-300 font-mono text-sm">{model}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-gray-600 text-xs">{m}/{t} fields</span>
                      <span className={`text-sm font-bold tabular-nums w-12 text-right ${t === 0 ? 'text-gray-500' : Math.round((m/t)*100) >= 95 ? 'text-green-400' : Math.round((m/t)*100) >= 80 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {pct(m, t)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── NORMALIZATION STATS ───────────────────────────────────────── */}
          {normStats.length > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">
                Stock # Normalization Rules Applied
              </h2>
              <div className="bg-gray-900 rounded-2xl p-5">
                <div className="grid grid-cols-[1fr_auto] gap-x-8 gap-y-2 text-sm">
                  {normStats.map(([rule, count]) => (
                    <Fragment key={rule}>
                      <span className="text-gray-300 font-mono">{RULE_LABELS[rule] ?? rule}</span>
                      <span className="text-gray-500 text-xs text-right tabular-nums">{count}×</span>
                    </Fragment>
                  ))}
                </div>
                <p className="text-gray-600 text-xs mt-4">
                  These are AI-read characters fixed by business rules before the employee sees the result.
                  High counts suggest the AI consistently misreads this character pattern.
                </p>
              </div>
            </section>
          )}

          {/* ── CHARACTER SUBSTITUTIONS ──────────────────────────────────── */}
          {subs.length > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">
                Most Common Employee Corrections (stock #)
              </h2>
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
                  Characters the employee changed after the AI prediction.
                  Distinct from normalization rules — these are missed by the automated rules.
                </p>
              </div>
            </section>
          )}

          {/* ── REPLAY TOOL ──────────────────────────────────────────────── */}
          <ReplayTool
            entryIds={allRows.map(e => e.id)}
            rerunCount={rerunRows.length}
          />

          {/* ── ENTRY LIST ───────────────────────────────────────────────── */}
          <section>
            <h2 className="text-gray-500 text-xs font-semibold uppercase tracking-widest mb-3">
              All Scans — AI Predictions vs Employee-Confirmed
            </h2>
            <div className="space-y-3">
              {allRows.map(e => {
                const conf     = (e.ocrConfidence ?? {}) as Record<string, number>
                const stockDiff = e.stockNumberAiPrediction && e.stockNumber
                  ? charDiff(e.stockNumberAiPrediction, e.stockNumber)
                  : null
                const normChanges = e.normalizationsApplied as NormalizationChange[] | null

                const fields: { label: string; ai: string | null; final: string | null; conf: number | null; wasCorrected: boolean }[] = [
                  { label: 'Year',    ai: e.aiYear,  final: e.year,        conf: conf.year        ?? null, wasCorrected: e.yearWasCorrected  },
                  { label: 'Make',    ai: e.aiMake,  final: e.make,        conf: conf.make        ?? null, wasCorrected: e.makeWasCorrected  },
                  { label: 'Model',   ai: e.aiModel, final: e.model,       conf: conf.model       ?? null, wasCorrected: e.modelWasCorrected },
                  { label: 'Color',   ai: e.aiColor, final: e.color,       conf: conf.color       ?? null, wasCorrected: e.colorWasCorrected },
                  { label: 'Stock #', ai: e.stockNumberAiPrediction, final: e.stockNumber, conf: conf.stockNumber ?? null, wasCorrected: e.stockWasCorrected },
                ]

                return (
                  <div key={e.id} className="bg-gray-900 rounded-2xl overflow-hidden">
                    <div className="flex gap-4 p-4">
                      <div className="flex-shrink-0 w-20 h-20 bg-gray-800 rounded-xl overflow-hidden">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={e.stockNumberCropUrl ?? e.photoUrl}
                          alt="Tag"
                          className="w-full h-full object-cover"
                        />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="text-gray-400 text-xs">
                            {new Date(e.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </span>
                          {e.dealershipName && (
                            <span className="text-xs bg-gray-800 text-gray-400 rounded px-2 py-0.5">{e.dealershipName}</span>
                          )}
                          {e.detectedStockPrefix && e.expectedDealerPrefix && (
                            <span className={`text-xs rounded px-2 py-0.5 ${e.detectedStockPrefix.toUpperCase() === e.expectedDealerPrefix.toUpperCase() ? 'bg-green-950 text-green-400' : 'bg-red-950 text-red-400'}`}>
                              prefix {e.detectedStockPrefix} / exp {e.expectedDealerPrefix}
                            </span>
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

                        {/* Raw OCR + normalization tags */}
                        {e.stockRawOcr && Array.isArray(normChanges) && normChanges.length > 0 && (
                          <div className="mb-2 flex items-center gap-2 flex-wrap">
                            <span className="text-gray-600 text-xs">raw OCR:</span>
                            <span className="text-orange-400 font-mono text-xs">{e.stockRawOcr}</span>
                            {normChanges.map((c, i) => (
                              <span key={i} className="text-xs bg-orange-950/50 text-orange-300 border border-orange-800/50 rounded px-1.5 py-0.5 font-mono">
                                {c.from}→{c.to}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Field table */}
                        <div className="grid grid-cols-[4rem_1fr_1fr_3rem] gap-x-3 gap-y-1 text-xs">
                          <span className="text-gray-600 uppercase tracking-wide font-semibold col-span-1"></span>
                          <span className="text-gray-600 uppercase tracking-wide">AI said</span>
                          <span className="text-gray-600 uppercase tracking-wide">Confirmed</span>
                          <span className="text-gray-600 uppercase tracking-wide text-right">Conf</span>

                          {fields.map(f => (
                            <Fragment key={f.label}>
                              <span className="text-gray-500">{f.label}</span>
                              <span className={`font-mono ${f.wasCorrected ? 'text-red-400' : 'text-gray-300'}`}>
                                {f.ai ?? <span className="text-gray-700">—</span>}
                              </span>
                              <span className={`font-mono ${f.wasCorrected ? 'text-green-400 font-bold' : 'text-gray-300'}`}>
                                {f.final ?? <span className="text-gray-700">—</span>}
                              </span>
                              <span className="text-gray-600 text-right tabular-nums">
                                {f.conf !== null ? `${Math.round(f.conf * 100)}%` : '—'}
                              </span>
                            </Fragment>
                          ))}
                        </div>

                        {/* Stock char diff */}
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
