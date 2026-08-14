/**
 * GET /api/quickbooks/query-items — read-only list of QuickBooks Products/Services.
 * Admin-only (proxy Basic-Auth matcher). A single SELECT — no writes. Used to audit the
 * retail service → QB item mapping.
 */
import { NextResponse } from 'next/server'
import { queryQBO } from '@/apps/quickbooks/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET() {
  try {
    const res = await queryQBO<{ Item?: any[] }>(`SELECT * FROM Item MAXRESULTS 1000`)
    const items = (res.Item ?? []).map((i) => ({
      id: i.Id, name: i.Name, fullyQualifiedName: i.FullyQualifiedName ?? null,
      type: i.Type, active: i.Active ?? true, income: i.IncomeAccountRef?.name ?? null,
      description: i.Description ?? null,
    }))
    return NextResponse.json({ ok: true, count: items.length, items })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
