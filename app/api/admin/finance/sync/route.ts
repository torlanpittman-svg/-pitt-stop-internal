/**
 * POST /api/admin/finance/sync — run the READ-ONLY QuickBooks ingestion for the CFO model.
 * Admin Basic-Auth gated via proxy.ts (same gate as /admin). Never writes to QuickBooks; only
 * upserts fin_* tables + records a sync run. Usable manually and by a daily cron.
 */
import { NextResponse } from 'next/server'
import { syncFromQbo } from '@/apps/finance/qbo-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const result = await syncFromQbo('admin')
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}
