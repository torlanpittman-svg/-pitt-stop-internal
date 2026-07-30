/**
 * POST /api/quickbooks/set-invoice-number?id=23424&number=100800
 *
 * One-off, owner-approved correction: set an invoice's DocNumber ONLY, leaving
 * every other field (customer, date, line, amount, memo…) untouched via a QBO
 * sparse update. Verifies the target number is free first; if taken, walks to
 * the next available number. Reads the invoice back and returns before/after.
 */
import { NextResponse } from 'next/server'
import { qbApiRequest, queryQBO, qboEscape } from '@/apps/quickbooks/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/* eslint-disable @typescript-eslint/no-explicit-any */
function summarize(inv: any) {
  return {
    id: inv.Id,
    docNumber: inv.DocNumber ?? null,
    syncToken: inv.SyncToken,
    customer: inv.CustomerRef ? { id: inv.CustomerRef.value, name: inv.CustomerRef.name } : null,
    txnDate: inv.TxnDate ?? null,
    total: inv.TotalAmt ?? null,
    lines: (inv.Line ?? [])
      .filter((l: any) => l.DetailType === 'SalesItemLineDetail')
      .map((l: any) => ({ amount: l.Amount, description: l.Description ?? null })),
  }
}

async function docNumberInUse(num: string, exceptId: string): Promise<boolean> {
  const res = await queryQBO<{ Invoice?: any[] }>(`SELECT Id FROM Invoice WHERE DocNumber = '${qboEscape(num)}'`)
  return (res.Invoice ?? []).some((i) => i.Id !== exceptId)
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    const desired = url.searchParams.get('number')
    if (!id || !desired) return NextResponse.json({ ok: false, error: 'pass ?id= and ?number=' }, { status: 400 })

    // 1. Fetch the invoice (need SyncToken; capture "before").
    const fetched = await qbApiRequest<{ Invoice: any }>({ path: `/invoice/${id}` })
    const before = summarize(fetched.Invoice)

    // 2. Find a free number starting at the requested one.
    let num = parseInt(desired, 10)
    let assigned = String(num)
    let walked = false
    for (let i = 0; i < 50; i++) {
      if (!(await docNumberInUse(assigned, id))) break
      walked = true
      num += 1
      assigned = String(num)
    }
    if (await docNumberInUse(assigned, id)) {
      return NextResponse.json({ ok: false, error: 'could not find a free DocNumber near ' + desired }, { status: 409 })
    }

    // 3. Sparse update — ONLY DocNumber changes.
    const upd = await qbApiRequest<{ Invoice: any }>({
      method: 'POST',
      path: '/invoice',
      body: { Id: id, SyncToken: fetched.Invoice.SyncToken, sparse: true, DocNumber: assigned },
    })

    // 4. Read back fresh.
    const after = summarize(upd.Invoice)
    return NextResponse.json({
      ok: after.docNumber === assigned,
      requested: desired,
      assigned,
      wasTaken: walked,
      before,
      after,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
