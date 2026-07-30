/**
 * GET /api/quickbooks/query-invoice?id=23424
 *   or ?customerId=6   (lists that customer's most recent invoices)
 *
 * Read-only. Reads live QuickBooks invoices to verify what was actually written.
 * A single SELECT — no writes.
 */
import { NextResponse } from 'next/server'
import { queryQBO, qboEscape } from '@/apps/quickbooks/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/* eslint-disable @typescript-eslint/no-explicit-any */
function summarize(inv: any) {
  return {
    id: inv.Id,
    docNumber: inv.DocNumber ?? null,
    customer: inv.CustomerRef ? { id: inv.CustomerRef.value, name: inv.CustomerRef.name } : null,
    txnDate: inv.TxnDate ?? null,
    total: inv.TotalAmt ?? null,
    balance: inv.Balance ?? null,
    emailStatus: inv.EmailStatus ?? null,
    printStatus: inv.PrintStatus ?? null,
    lineCount: Array.isArray(inv.Line) ? inv.Line.length : 0,
    lines: (inv.Line ?? [])
      .filter((l: any) => l.DetailType === 'SalesItemLineDetail')
      .map((l: any) => ({ amount: l.Amount, description: l.Description ?? null, item: l.SalesItemLineDetail?.ItemRef })),
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    const customerId = url.searchParams.get('customerId')

    if (id) {
      const res = await queryQBO<{ Invoice?: any[] }>(`SELECT * FROM Invoice WHERE Id = '${qboEscape(id)}'`)
      const inv = res.Invoice?.[0]
      return NextResponse.json({ ok: !!inv, found: !!inv, invoice: inv ? summarize(inv) : null })
    }

    if (customerId) {
      const res = await queryQBO<{ Invoice?: any[] }>(
        `SELECT * FROM Invoice WHERE CustomerRef = '${qboEscape(customerId)}' ORDERBY MetaData.CreateTime DESC MAXRESULTS 10`,
      )
      const invoices = (res.Invoice ?? []).map(summarize)
      return NextResponse.json({ ok: true, customerId, count: invoices.length, invoices })
    }

    return NextResponse.json({ ok: false, error: 'pass ?id= or ?customerId=' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
