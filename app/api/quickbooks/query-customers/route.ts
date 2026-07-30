/**
 * GET /api/quickbooks/query-customers?name=Sterling
 *
 * Read-only. Lists live QuickBooks customers whose DisplayName starts with the
 * given prefix (default "Sterling"). Runs a single SELECT against the connected
 * company — no writes, no mutations. Used to verify dealer customers (Sterling
 * Auto / Kia / Subaru) after the production OAuth connection.
 */
import { NextResponse } from 'next/server'
import { queryQBO, qboEscape } from '@/apps/quickbooks/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RawCustomer {
  Id: string
  DisplayName: string
  Active?: boolean
  CompanyName?: string
}

export async function GET(req: Request) {
  try {
    const name = new URL(req.url).searchParams.get('name') || 'Sterling'
    const res = await queryQBO<{ Customer?: RawCustomer[] }>(
      `SELECT Id, DisplayName, CompanyName, Active FROM Customer ` +
        `WHERE DisplayName LIKE '${qboEscape(name)}%' ORDERBY DisplayName MAXRESULTS 100`,
    )
    const customers = (res.Customer ?? []).map((c) => ({
      id: c.Id,
      name: c.DisplayName,
      companyName: c.CompanyName ?? null,
      active: c.Active ?? true,
    }))
    return NextResponse.json({ ok: true, prefix: name, count: customers.length, customers })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
