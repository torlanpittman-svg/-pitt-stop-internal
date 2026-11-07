/**
 * PURE presentational view for the insurance-restoration report: everything on /marketing/restoration below
 * the shell is rendered from a RestorationReport value with NO auth, DB, network or settings access, so it
 * can be rendered locally against synthetic props (ReportView.test.tsx + scripts/preview-restoration-report.ts)
 * without touching production — the safe-review harness for a page whose live render needs migration 0076.
 *
 * Honesty rules the markup enforces: missing data renders as "—" or "Unavailable", never $0; profitability
 * is shown as UNMEASURED (labor cost is not captured — owner decision 2026-11-07: no modeled labor, no
 * contribution figures); paid unit costs are labelled with their exact denominators.
 */
import { Section, StatTile, StatusChip, EmptyRow } from '@/app/marketing/_components'
import { AdDataNotice } from '@/app/marketing/AdDataNotice'
import { money, bigMoney, count, shortDate } from '@/app/lib/format'
import { DAMAGE_TYPE_LABEL, CLAIM_STATUS_LABEL, QUALIFIED_LEAD_STATUSES, type RestorationReport } from '@/apps/marketing/restoration-report'
import { ACCOUNT_TIME_ZONE } from '@/apps/marketing/ad-dates'

const big = (c: number | null | undefined) => (c == null ? '—' : bigMoney(c))
const th = 'px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500'
const td = 'px-2 py-1.5 text-sm text-gray-200'

function Breakdown({ title, data, label = (k: string) => k }: { title: string; data: Record<string, number>; label?: (k: string) => string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{title}</div>
      {entries.length === 0 ? <div className="mt-1 text-sm text-gray-500">No leads in this window.</div> : (
        <ul className="mt-1 space-y-0.5">
          {entries.map(([k, v]) => <li key={k} className="flex justify-between text-sm"><span className="text-gray-300">{label(k)}</span><span className="font-semibold text-white">{count(v)}</span></li>)}
        </ul>
      )}
    </div>
  )}

export function RestorationReportView({ report: r }: { report: RestorationReport }) {
  const pctLeads = (n: number) => (r.funnel.leads ? ` · ${Math.round((n / r.funnel.leads) * 100)}% of leads` : '')
  return (
    <>
      <p className="mb-4 text-sm text-gray-400">
        {shortDate(r.range.from)} – {shortDate(r.range.to)} ({ACCOUNT_TIME_ZONE}). Leads by request date; completions and revenue by completion date.
        Goal to validate: $5,000/month completed, QuickBooks-invoiced restoration revenue.
      </p>
      <AdDataNotice meta={r.ads.meta} className="mb-4" />

      <Section title="Funnel (unique leads, duplicates removed)">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <StatTile label="Leads" value={count(r.funnel.leads)} note={r.leads.duplicates ? `+${r.leads.duplicates} duplicate${r.leads.duplicates === 1 ? '' : 's'}` : 'no duplicates'} />
          <StatTile label="Qualified" value={count(r.funnel.qualified)} note={`status past “new”${pctLeads(r.funnel.qualified)}`} />
          <StatTile label="Estimates" value={count(r.funnel.estimates)} note="written estimate or estimate sent" />
          <StatTile label="Booked" value={count(r.funnel.booked)} note="linked to a job or marked booked" />
          <StatTile label="Completed" value={count(r.funnel.completed)} note="restoration jobs completed in window" />
          <StatTile label="Invoiced" value={count(r.funnel.invoiced)} note="QuickBooks-anchored" />
          <StatTile label="Cancelled" value={count(r.funnel.cancelled)} note="linked jobs cancelled" />
        </div>
      </Section>

      <Section title="Revenue, spend and acquisition">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Invoiced revenue" value={big(r.revenue.invoicedCents)} note={r.revenue.avgInvoicedTicketCents != null ? `avg ticket ${money(r.revenue.avgInvoicedTicketCents)}` : 'no invoiced jobs'} />
          <StatTile label="Quoted, not invoiced" value={big(r.revenue.quotedUninvoicedCents)} note="completed jobs without a QB invoice" />
          <StatTile label="Google Ads spend" value={r.ads.spendCents == null ? 'Unavailable' : big(r.ads.spendCents)} note={r.ads.spendCents == null ? 'no restoration campaign data — unknown, not $0' : r.ads.clicks != null ? `${count(r.ads.clicks)} clicks · ${count(r.ads.conversions)} conv.` : 'restoration campaigns'} />
          <StatTile label="Cost per paid lead" value={r.unit.costPerPaidLeadCents == null ? '—' : money(r.unit.costPerPaidLeadCents)} note={`spend ÷ ${count(r.unit.paidLeads)} Google Ads lead${r.unit.paidLeads === 1 ? '' : 's'}`} />
          <StatTile label="Blended cost / completed job" value={r.unit.blendedCostPerCompletedJobCents == null ? '—' : money(r.unit.blendedCostPerCompletedJobCents)} note="spend ÷ ALL completed jobs — not an acquisition cost" />
          <StatTile label="Paid CAC (new customers)" value={r.unit.paidCacCents == null ? '—' : money(r.unit.paidCacCents)} note={`spend ÷ ${count(r.unit.paidNewCustomersInvoiced)} new invoiced Google Ads customer${r.unit.paidNewCustomersInvoiced === 1 ? '' : 's'} · target < $200`} />
          <StatTile label="Parts + sublet cost" value={money(r.costs.partsCostCents + r.costs.subletCostCents)} note="recorded line-item cost, invoiced jobs" />
          <StatTile label="Profitability" value="Unmeasured" note="labor cost is not captured — no contribution or margin is computed" />
        </div>
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-gray-500">{r.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
      </Section>

      <Section title="Unique leads by damage type, channel, landing page, claim status">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Breakdown title="Damage type" data={r.leads.byDamageType} label={DAMAGE_TYPE_LABEL} />
          <Breakdown title="Channel (click attribution)" data={r.leads.bySource} label={(k) => k.replace(/_/g, ' ')} />
          <Breakdown title="Landing page" data={r.leads.byLandingPage} />
          <Breakdown title="Insurance claim (customer’s answer)" data={r.leads.byClaimStatus} label={CLAIM_STATUS_LABEL} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <StatTile label="Matched to a job" value={count(r.leads.matched)} />
          <StatTile label="Unmatched" value={count(r.leads.unmatched)} note="link from Leads → “link to order”" />
          <StatTile label="Shop email not sent" value={count(r.leads.emailNotSent)} note="lead saved; follow up by phone" />
        </div>
      </Section>

      <Section title="Revenue by damage type and channel (completed in window)">
        {r.orders.length === 0 ? <EmptyRow>No completed restoration jobs in this window.</EmptyRow> : (
          <div className="grid gap-4 md:grid-cols-2">
            <table className="w-full"><thead><tr><th className={th}>Damage type</th><th className={th}>Jobs</th><th className={th}>Invoiced</th></tr></thead>
              <tbody>{Object.entries(r.revenue.byDamageType).map(([k, v]) => <tr key={k} className="border-t border-gray-800"><td className={td}>{DAMAGE_TYPE_LABEL(k)}</td><td className={td}>{count(v.orders)}</td><td className={td}>{money(v.invoicedCents)}</td></tr>)}</tbody></table>
            <table className="w-full"><thead><tr><th className={th}>Channel</th><th className={th}>Jobs</th><th className={th}>Invoiced</th></tr></thead>
              <tbody>{Object.entries(r.revenue.bySource).map(([k, v]) => <tr key={k} className="border-t border-gray-800"><td className={td}>{k.replace(/_/g, ' ')}</td><td className={td}>{count(v.orders)}</td><td className={td}>{money(v.invoicedCents)}</td></tr>)}</tbody></table>
          </div>
        )}
        {r.revenue.repeatCustomers > 0 && <p className="mt-2 text-xs text-gray-500">{count(r.revenue.repeatCustomers)} customer(s) completed more than one restoration job in this window; each job counts once, and repeat customers are excluded from paid CAC.</p>}
      </Section>

      <Section title="Restoration leads in window">
        {r.leads.rows.length === 0 ? <EmptyRow>No restoration estimate requests in this window.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr><th className={th}>Received</th><th className={th}>Damage</th><th className={th}>Name</th><th className={th}>Channel</th><th className={th}>Landing page</th><th className={th}>Claim</th><th className={th}>Photos</th><th className={th}>Status</th><th className={th}>Job</th><th className={th}>Flags</th></tr></thead>
              <tbody>
                {[...r.leads.rows].reverse().map((l) => (
                  <tr key={l.leadId} className="border-t border-gray-800">
                    <td className={td}>{shortDate(l.createdAt.toISOString().slice(0, 10))}</td>
                    <td className={td}>{DAMAGE_TYPE_LABEL(l.damageType)}</td>
                    <td className={td}>{l.name ?? '—'}</td>
                    <td className={td}>{l.source.replace(/_/g, ' ')}</td>
                    <td className={td}>{l.landingPage ?? '—'}</td>
                    <td className={td}>{l.claimStatus ? CLAIM_STATUS_LABEL(l.claimStatus) : '—'}</td>
                    <td className={td}>{l.photoCount}</td>
                    <td className={td}><StatusChip status={l.status} /></td>
                    <td className={td}>{l.serviceOrderId ? <a className="underline" href={`/orders/${l.serviceOrderId}`}>{l.orderCompleted ? 'completed' : l.orderCancelled ? 'cancelled' : 'open'}</a> : <a className="underline" href={`/marketing/leads?linkLead=${l.leadId}`}>link</a>}</td>
                    <td className={td}>{[l.duplicateOf ? 'duplicate' : null, l.emailStatus !== 'sent' ? `email ${l.emailStatus}` : null].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-gray-500">Qualified = status in {QUALIFIED_LEAD_STATUSES.join(', ').replace(/_/g, ' ')}. Duplicates share a phone or email with another request in the window; the lead that progressed furthest (linked job, then status) is the one the funnel counts, and the rest are flagged here.</p>
          </div>
        )}
      </Section>
    </>
  )
}
