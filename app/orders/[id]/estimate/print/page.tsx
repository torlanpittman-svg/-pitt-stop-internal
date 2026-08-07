/**
 * /orders/[id]/estimate/print — clean printable/shareable estimate summary.
 * Manager-gated. Clearly marks which lines are taxable. No pricing engine here —
 * renders the cached figures. V1 print-only (no SMS/email/portal).
 */
import { cookies } from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import { parseActor, verifyElevation, effectiveRole } from '@/apps/workflow/identity'
import { estimateEnabled } from '@/apps/workflow/estimate'
import { getOrderWithContext } from '@/apps/workflow/db'
import { getFullEstimate } from '@/apps/workflow/estimate-db'

export const dynamic = 'force-dynamic'
const fmt = (c: number) => `$${((c || 0) / 100).toFixed(2)}`
const amt = (price: number, qty: string) => fmt(Math.round(price * (parseFloat(qty) || 0)))

export default async function EstimatePrintPage({ params }: { params: Promise<{ id: string }> }) {
  if (!estimateEnabled()) redirect('/')
  const c = await cookies()
  const role = effectiveRole(parseActor(c.get('ps_actor')?.value), verifyElevation(c.get('ps_elev')?.value))
  if (role !== 'manager' && role !== 'admin') redirect('/')
  const { id } = await params
  const order = await getOrderWithContext(id)
  if (!order) notFound()
  const full = await getFullEstimate(id)
  if (!full?.estimate) notFound()
  const e = full.estimate
  const customer = order.customerName?.trim() || 'Customer'
  const vehicle = [order.vehicle.year, order.vehicle.make, order.vehicle.model].filter(Boolean).join(' ') || 'Vehicle'

  return (
    <main style={{ background: '#fff', color: '#111', minHeight: '100vh', padding: '32px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #111', paddingBottom: 12 }}>
          <div><h1 style={{ margin: 0, fontSize: 24 }}>Pitt Stop — Estimate</h1><p style={{ margin: '4px 0', color: '#555' }}>{customer} · {vehicle}</p></div>
          <div style={{ textAlign: 'right', color: '#555', fontSize: 13 }}>Status: {e.status.replace(/_/g, ' ')}<br />{new Date().toLocaleDateString()}</div>
        </div>

        {full.services.map((s) => (
          <div key={s.id} style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{s.title}</h3>
              <span style={{ fontSize: 12, textTransform: 'capitalize', color: s.approvalState === 'approved' ? '#0a0' : s.approvalState === 'declined' ? '#c00' : '#a70' }}>{s.approvalState}</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 6 }}>
              <thead><tr style={{ color: '#777', textAlign: 'left' }}><th>Item</th><th>Type</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'center' }}>Taxable</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {s.lines.map((l) => (
                  <tr key={l.id} style={{ borderTop: '1px solid #eee' }}>
                    <td>{l.name}</td><td style={{ textTransform: 'capitalize' }}>{l.type}</td>
                    <td style={{ textAlign: 'right' }}>{parseFloat(l.qty)}</td><td style={{ textAlign: 'right' }}>{fmt(l.priceCents)}</td>
                    <td style={{ textAlign: 'center' }}>{l.taxable ? 'Yes' : 'No'}</td>
                    <td style={{ textAlign: 'right' }}>{amt(l.priceCents, l.qty)}</td>
                  </tr>
                ))}
                {s.lines.length === 0 && <tr><td colSpan={6} style={{ color: '#999', padding: '4px 0' }}>No line items.</td></tr>}
              </tbody>
            </table>
          </div>
        ))}

        <div style={{ marginTop: 24, marginLeft: 'auto', width: 300 }}>
          <Row label="Taxable subtotal" value={fmt(e.taxableSubtotalCents)} />
          <Row label="Non-taxable subtotal" value={fmt(e.nontaxableSubtotalCents)} />
          <Row label={`Tax (${(e.taxRateBps / 100).toFixed(2)}%)`} value={fmt(e.taxCents)} />
          <div style={{ borderTop: '2px solid #111', marginTop: 6, paddingTop: 6 }}><Row label="Grand total" value={fmt(e.totalCents)} bold /></div>
        </div>
        {e.needsTaxReview && <p style={{ color: '#a70', fontSize: 12, marginTop: 12 }}>⚠ Some lines are flagged for tax review — final tax treatment to be confirmed.</p>}
        <p style={{ color: '#999', fontSize: 11, marginTop: 24 }}>Estimate only — not an invoice. Prices subject to confirmation.</p>
      </div>
    </main>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: bold ? 700 : 400 }}><span>{label}</span><span>{value}</span></div>
}
