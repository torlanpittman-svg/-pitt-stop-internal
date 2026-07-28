/**
 * POST /api/quickbooks/selftest-invoice  — SANDBOX ONLY.
 *
 * End-to-end validation of the QB invoice write path: ensure item/account,
 * create an invoice for Sterling Kia, append a second line, read it back, and
 * confirm findAppendableInvoice picks it up. Hard-refuses on any non-sandbox
 * environment so it can never touch production books.
 */
import { NextResponse } from 'next/server'
import { getConnectionStatus } from '@/apps/quickbooks/connection'
import { findCustomerByName } from '@/apps/quickbooks/customers'
import {
  resolveDealerDetailItem,
  resolveDueOnReceiptTermId,
  createDealerInvoice,
  appendDealerLine,
  getInvoiceSummary,
} from '@/apps/quickbooks/invoice-write'
import { findAppendableInvoice, listInvoicesForCustomer } from '@/apps/quickbooks/invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const status = await getConnectionStatus()
  if (status.environment !== 'sandbox') {
    return NextResponse.json({ ok: false, error: 'Refused: self-test only runs on sandbox.' }, { status: 403 })
  }
  if (!status.connected) {
    return NextResponse.json({ ok: false, error: 'QuickBooks not connected.' }, { status: 409 })
  }

  const steps: Record<string, unknown> = {}
  try {
    const kia = await findCustomerByName('Sterling Kia')
    if (!kia) return NextResponse.json({ ok: false, error: 'Sterling Kia not found; run setup-dealers first.' }, { status: 409 })
    steps.customer = { id: kia.id, name: kia.displayName }

    const itemId = await resolveDealerDetailItem()
    const salesTermId = await resolveDueOnReceiptTermId()
    steps.itemId = itemId
    steps.salesTermId = salesTermId

    const today = new Date().toISOString().slice(0, 10)
    const created = await createDealerInvoice({
      customerId: kia.id,
      itemId,
      salesTermId,
      line: { description: '2021 Honda Civic Gray #K518991', amount: 200, serviceDate: today },
    })
    steps.created = created

    const appended = await appendDealerLine({
      invoiceId: created.invoiceId,
      itemId,
      line: { description: '2024 Kia Telluride Gray #K473262', amount: 200, serviceDate: today },
    })
    steps.appended = appended

    const readBack = await getInvoiceSummary(created.invoiceId)
    steps.readBack = readBack

    const appendable = await findAppendableInvoice(kia.id)
    steps.appendableResolvesToSame = appendable?.id === created.invoiceId

    const allForKia = await listInvoicesForCustomer(kia.id)
    steps.kiaInvoiceCount = allForKia.length

    const checks = {
      createdOneLine:   created.lineCount === 1,
      appendedTwoLines: appended.lineCount === 2,
      readBackTwoLines: readBack.lineCount === 2,
      appendableMatch:  appendable?.id === created.invoiceId,
    }
    const pass = Object.values(checks).every(Boolean)
    return NextResponse.json({ ok: pass, checks, steps })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err), steps }, { status: 500 })
  }
}
