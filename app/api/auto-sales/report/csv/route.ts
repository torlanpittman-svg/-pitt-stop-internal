/**
 * Auto Sales — Monthly report CSV export (detailed rows for the accountant package). Path is under the
 * proxy-gated /api/auto-sales/* tree (employee session or admin); we additionally require a MANAGER
 * identity, matching the admin report surface. Read-only; recomputed from source (reproducible). No
 * QuickBooks writes. Dollars are rendered from integer cents (no floating-point).
 */
import { NextRequest, NextResponse } from 'next/server'
import { authenticatedActorFromRequest, isManagerRole } from '@/apps/auth/employee-guard'
import { employeeAuthConfigured } from '@/apps/auth/employee-session'
import { loadMonthlyReport, isValidMonth, currentReportMonth } from '@/apps/auto-sales/report-db'

const d = (c: number | null | undefined) => c == null ? '' : (c / 100).toFixed(2)
function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const row = (cells: unknown[]) => cells.map(esc).join(',')

export async function GET(req: NextRequest) {
  if (employeeAuthConfigured()) {
    const actor = await authenticatedActorFromRequest(req)
    if (!actor || !isManagerRole(actor.role)) return NextResponse.json({ ok: false, error: 'Manager sign-in required' }, { status: 403 })
  }
  const monthParam = req.nextUrl.searchParams.get('month') || ''
  const month = isValidMonth(monthParam) ? monthParam : currentReportMonth()
  const r = await loadMonthlyReport(month)
  const s = r.summary
  const lines: string[] = []
  lines.push(row(['Auto Sales Monthly Report', month, `timezone ${r.tz}`, `generated ${r.generatedAt} UTC`, `content-hash ${r.contentHash}`]))
  lines.push('')
  lines.push(row(['A. MONTH SUMMARY']))
  lines.push(row(['Metric', 'Count', 'Amount']))
  lines.push(row(['Beginning inventory', s.beginningInventoryCount, d(s.beginningInventoryValueCents)]))
  lines.push(row(['Vehicles acquired', s.acquiredCount, d(s.acquiredPriceTotalCents)]))
  lines.push(row(['Acquisition-related costs added', '', d(s.acquisitionRelatedAddedCents)]))
  lines.push(row(['Repairs/reconditioning added', '', d(s.reconAddedCents)]))
  lines.push(row(['Vehicles sold', s.soldCount, d(s.salesPriceTotalCents)]))
  lines.push(row(['Taxes collected (pass-through)', '', d(s.taxCollectedCents)]))
  lines.push(row(['Customer fees collected', '', d(s.feesCollectedCents)]))
  lines.push(row(['Discounts/allowances', '', d(s.discountsCents)]))
  lines.push(row(['Total transaction amount', '', d(s.totalTransactionCents)]))
  lines.push(row(['Amount received', '', d(s.amountReceivedCents)]))
  lines.push(row(['Receivables remaining', '', d(s.receivablesRemainingCents)]))
  lines.push(row(['Cost basis of vehicles sold', '', d(s.costBasisOfSoldCents)]))
  lines.push(row(['Estimated gross profit on sold', '', d(s.estGrossProfitOnSoldCents)]))
  lines.push(row(['Ending inventory', s.endingInventoryCount, d(s.endingInventoryValueCents)]))
  lines.push(row(['Missing acquisition price', s.missingAcquisitionPriceCount, d(s.missingAcquisitionPriceValueCents)]))
  lines.push(row(['Sold w/ incomplete info', s.soldIncompleteCount, '']))
  lines.push(row(['Reversed/corrected sales', s.reversedSalesCount, '']))
  lines.push('')
  lines.push(row(['B. VEHICLES ACQUIRED']))
  lines.push(row(['Stock', 'Vehicle', 'VIN', 'Acquired', 'Acq. price', 'Acq. costs', 'Recon this month', 'Recon to date', 'Status', 'Flags']))
  for (const v of r.acquired) lines.push(row([v.stockNumber, v.ymm, v.vin, v.acquisitionDate, d(v.acquisitionPriceCents), d(v.acquisitionRelatedCents), d(v.reconThisMonthCents), d(v.reconToDateCents), v.status, v.flags.join('; ')]))
  lines.push('')
  lines.push(row(['C. VEHICLES SOLD']))
  lines.push(row(['Stock', 'Vehicle', 'VIN', 'Acquired', 'Sold', 'Buyer', 'Acq. price', 'Acq. costs', 'Recon', 'Total cost', 'Sale price', 'Tax', 'Fees', 'Discount', 'Total transaction', 'Amount received', 'Balance', 'Est. gross profit', 'Payment', 'Salesperson', 'Flags']))
  for (const v of r.sold) lines.push(row([v.stockNumber, v.ymm, v.vin, v.acquisitionDate, v.saleDate, v.buyer, d(v.acquisitionPriceCents), d(v.acquisitionRelatedCents), d(v.reconditioningCents), d(v.totalInvestedCents), d(v.salePriceCents), d(v.taxCents), d(v.feesCents), d(v.discountCents), d(v.totalTransactionCents), d(v.amountReceivedCents), d(v.balanceRemainingCents), d(v.estGrossProfitCents), v.paymentMethod, v.salesperson, v.flags.join('; ')]))
  lines.push('')
  lines.push(row(['D. MONTH-END INVENTORY']))
  lines.push(row(['Stock', 'Vehicle', 'VIN', 'Acquired', 'Days', 'Acq. price', 'Acq. costs', 'Recon', 'Total cost', 'Status', 'Flags']))
  for (const v of r.endingInventory) lines.push(row([v.stockNumber, v.ymm, v.vin, v.acquisitionDate, v.daysInInventory, d(v.acquisitionPriceCents), d(v.acquisitionRelatedCents), d(v.reconditioningCents), d(v.totalInvestedCents), v.status, v.flags.join('; ')]))

  const csv = lines.join('\n')
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="auto-sales-${month}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
