import { requireMarketingManager, MarketingShell, Section, StatTile, StatusChip, EmptyRow } from '@/app/marketing/_components'
import { money, count, shortDate } from '@/app/lib/format'
import {
  updateCampaignCopyAction, generateCopyAction, buildRecipientsAction,
  approveCampaignAction, sendCampaignAction, cancelCampaignAction,
} from '@/app/marketing/actions'
import { getCampaign, listRecipients } from '@/apps/marketing/db'
import { campaignFunnel } from '@/apps/marketing/attribution'
import { CHANNELS } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireMarketingManager('/marketing/campaigns')
  const { id } = await params
  const campaign = await getCampaign(id)

  if (!campaign) {
    return (
      <MarketingShell active="/marketing/campaigns" title="Campaign">
        <EmptyRow>Campaign not found.</EmptyRow>
      </MarketingShell>
    )
  }

  const funnel = await campaignFunnel(id)
  const all = await listRecipients(id)
  const recipients = all.slice(0, 100)
  const pending = all.filter((r) => r.status === 'pending').length
  const excluded = all.filter((r) => r.status === 'excluded').length
  const sent = all.filter((r) => r.status === 'sent').length

  const canApprove = campaign.status === 'draft'
  const canSend = campaign.status === 'ready' || campaign.status === 'scheduled'
  const canCancel = !['sent', 'completed', 'cancelled'].includes(campaign.status)

  const idInput = <input type="hidden" name="id" value={campaign.id} />

  return (
    <MarketingShell active="/marketing/campaigns" title={campaign.name}
      actions={<StatusChip status={campaign.status} />}>

      {campaign.dryRun && (
        <div className="mb-4 rounded-xl border border-amber-700/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
          Dry-run mode — no messages are actually sent. Configure an SMS/email provider to go live.
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Recipients" value={count(funnel.recipients)} />
        <StatTile label="Sent" value={count(funnel.sent)} note={`${count(funnel.excluded)} excluded`} />
        <StatTile label="Responses" value={count(funnel.responses)} />
        <StatTile label="Appointments" value={count(funnel.appointments)} />
        <StatTile label="Completed jobs" value={count(funnel.completedJobs)} />
        <StatTile label="Completed revenue" value={money(funnel.completedRevenueCents)} />
      </div>

      <Section title="Campaign copy">
        <form action={updateCampaignCopyAction} className="space-y-4">
          {idInput}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Name</label>
              <input name="name" type="text" defaultValue={campaign.name}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Channel</label>
              <select name="channel" defaultValue={campaign.channel} className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm">
                {CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>{ch}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">SMS copy</label>
            <textarea name="smsCopy" rows={3} defaultValue={campaign.smsCopy ?? ''}
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Email subject</label>
            <input name="emailSubject" type="text" defaultValue={campaign.emailSubject ?? ''}
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Email body</label>
            <textarea name="emailBody" rows={6} defaultValue={campaign.emailBody ?? ''}
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Offer</label>
            <input name="offer" type="text" defaultValue={campaign.offer ?? ''}
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-gray-500">Leave blank unless an offer is actually approved — AI never invents one.</p>
          </div>

          <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Save</button>
        </form>
      </Section>

      <Section title="Actions">
        <div className="flex flex-wrap items-center gap-2">
          <form action={generateCopyAction}>
            {idInput}
            <button type="submit" className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700">Generate AI copy</button>
          </form>
          <form action={buildRecipientsAction}>
            {idInput}
            <button type="submit" className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700">Build recipients</button>
          </form>
          {canApprove && (
            <form action={approveCampaignAction}>
              {idInput}
              <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Approve (Ready)</button>
            </form>
          )}
          {canSend && (
            <form action={sendCampaignAction}>
              {idInput}
              <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Send (dry-run)</button>
            </form>
          )}
          {canCancel && (
            <form action={cancelCampaignAction}>
              {idInput}
              <button type="submit" className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-1.5 text-sm font-semibold text-red-300 hover:bg-red-900/40">Cancel</button>
            </form>
          )}
        </div>
      </Section>

      <Section title="Recipients" right={<span className="text-xs text-gray-500">{count(pending)} pending · {count(excluded)} excluded · {count(sent)} sent</span>}>
        {recipients.length === 0 ? <EmptyRow>No recipients built yet. Use “Build recipients” to populate from the segment.</EmptyRow> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="pb-2">Channel</th>
                  <th className="pb-2">Address</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Exclusion reason</th>
                  <th className="pb-2 text-right">Sent</th>
                </tr>
              </thead>
              <tbody>
                {recipients.map((r) => (
                  <tr key={r.id} className="border-t border-gray-800">
                    <td className="py-2 text-gray-400">{r.channel}</td>
                    <td className="py-2">{r.addressSnapshot || '—'}</td>
                    <td className="py-2"><StatusChip status={r.status} /></td>
                    <td className="py-2 text-gray-500">{r.exclusionReason || '—'}</td>
                    <td className="py-2 text-right text-gray-500">{shortDate(r.sentAt ? r.sentAt.toISOString().slice(0, 10) : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </MarketingShell>
  )
}
