/**
 * /checks/print — the print-ready check render (manager-only).
 *   ?id=<checkId>  → a REAL recorded check (must be recorded in QuickBooks to print)
 *   ?test=1        → TEST PRINT: sample data, big VOID watermark, creates NO record and NO QuickBooks txn
 *   ?offx=&offy=&pos=  → live calibration overrides (inches / top|middle|bottom) applied on top of saved layout
 *
 * Layout comes entirely from the central check-layout config (apps/checks/layout.ts) merged with saved
 * calibration — no coordinates live here. Printing is the browser's native print dialog to the Brother
 * HL-L2420DW (the Mac's default printer). Never prints bank routing/account/MICR.
 */
import { redirect } from 'next/navigation'
import { managerActor } from '@/apps/checks/authz'
import { getCheckConfig } from '@/apps/checks/config'
import { buildLayout, PAGE_WIDTH_IN, PAGE_HEIGHT_IN, type CheckPosition } from '@/apps/checks/layout'
import { buildFields, checkValues, testValues } from '@/apps/checks/render'
import { getCheckView } from '@/apps/checks/db'
import CheckPrintClient from './CheckPrintClient'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function CheckPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await managerActor()
  if (!actor) redirect('/auto-sales/login?next=/checks')

  const sp = await searchParams
  const id = typeof sp.id === 'string' ? sp.id : null
  const isTest = sp.test === '1' || sp.test === 'true'

  const cfg = await getCheckConfig()
  // Live calibration overrides on top of saved layout.
  const offx = sp.offx != null ? parseFloat(String(sp.offx)) : undefined
  const offy = sp.offy != null ? parseFloat(String(sp.offy)) : undefined
  const pos = (['top', 'middle', 'bottom'] as const).includes(sp.pos as CheckPosition) ? (sp.pos as CheckPosition) : undefined
  const layout = buildLayout({
    ...cfg.layout,
    ...(offx != null && Number.isFinite(offx) ? { offsetX: offx } : {}),
    ...(offy != null && Number.isFinite(offy) ? { offsetY: offy } : {}),
    ...(pos ? { position: pos } : {}),
  })

  // Resolve the values to print (shared with the PDF/queue path via render.ts).
  let values: Record<string, string>
  let checkId: string | null = null
  let checkNumber: number | null = null
  let printable = false
  if (isTest || !id) {
    values = testValues()
  } else {
    const c = await getCheckView(id)
    if (!c) redirect('/checks')
    checkId = c!.id
    checkNumber = c!.checkNumber
    printable = c!.qbStatus === 'recorded'
    values = checkValues(c!)
  }

  // Positioned fields for the client (inches → the client converts to CSS).
  const fields = buildFields(values, layout)

  return (
    <CheckPrintClient
      pageWidthIn={PAGE_WIDTH_IN}
      pageHeightIn={PAGE_HEIGHT_IN}
      fields={fields}
      isTest={isTest || !id}
      checkId={checkId}
      checkNumber={checkNumber}
      printable={printable}
      alreadyPrinted={false}
      calibration={{ offsetX: layout.offsetX, offsetY: layout.offsetY, position: layout.position }}
    />
  )
}
