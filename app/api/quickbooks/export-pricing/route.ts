/**
 * GET /api/quickbooks/export-pricing   (header: X-Export-Key)  — TEMPORARY.
 * Read-only bulk export for the historical pricing inventory: paginated
 * Invoice + SalesReceipt + Item + Customer via SELECT only (queryQBO). No writes.
 * Remove after the one-time export.
 */
import { NextResponse } from 'next/server'
import { queryQBO } from '@/apps/quickbooks/client'
import { getEnvironment } from '@/apps/quickbooks/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/* eslint-disable @typescript-eslint/no-explicit-any */
async function all(entity: string): Promise<any[]> {
  const out: any[] = []
  let pos = 1
  for (;;) {
    const res = await queryQBO<Record<string, any[]>>(`SELECT * FROM ${entity} ORDER BY Id STARTPOSITION ${pos} MAXRESULTS 1000`)
    const batch = (res[entity] as any[]) ?? []
    out.push(...batch)
    if (batch.length < 1000) break
    pos += batch.length
  }
  return out
}

export async function GET(req: Request) {
  if (!process.env.EXPORT_KEY || req.headers.get('x-export-key') !== process.env.EXPORT_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const [invoices, salesReceipts, items, customers] = await Promise.all([
    all('Invoice'), all('SalesReceipt'), all('Item'), all('Customer'),
  ])
  return NextResponse.json({ environment: getEnvironment(), invoices, salesReceipts, items, customers })
}
