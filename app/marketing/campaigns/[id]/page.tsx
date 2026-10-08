import { requireMarketingManager, MarketingShell, Section, StatTile, StatusChip, EmptyRow, Pager, FlashBanner } from '@/app/marketing/_components'
import { money, count, shortDate } from '@/app/lib/format'
import {
  updateCampaignCopyAction, generateCopyAction, buildRecipientsAction,
  approveCampaignAction, sendCampaignAction, cancelCampaignAction, sendCampaignEmailAction,
} from '@/app/marketing/actions'
import { getCampaign, listRecipients, countRecipients } from '@/apps/marketing/db'
import { campaignFunnel } from '@/apps/marketing/attribution'
import { emailSendReadiness } from '@/apps/marketing/manual-send'
import { CHANNELS } from '@/apps/marketing/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export default async function CampaignDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ page?: string; err?: string; msg?: string; send?: string }>
}) {
  await requireMarketingManager('/marketing/campaigns')
  const { id } = await params
  const { page: pageRaw, err, msg, send } = await searchParams
  const campaign = await getCampaign(id)

  if (!campaign) {
    return (
      <MarketingShell active="/marketing/campaigns" title="Campaign">
        <EmptyRow>Campaign not found.</EmptyRow>
      </MarketingShell>
    )
  }

  const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1)
  const funnel = await campaignFunnel(id)
  const total = await countRecipients(id)
  const recipients = await listRecipients(id, undefined, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
  const excluded = funnel.excluded
  const sent = funnel.sent

  const canApprove = campaign.status === 'draft'
  const canSend = campaign.status === 'ready' || campaign.status === 'scheduled'
  const canCancel = !['sent', 'completed', 'cancelled'].includes(campaign.status)
  const isEmailCampaign = campaign.channel === 'email' || campaign.channel === 'both'
  // Only fetch the authoritative MailerLite audience when the manager explicitly opens the send step.
  const emailReady = isEmailCampaign && send === '1' ? await emailSendReadiness(id) : null

  const idInput = <input type="hidden" name="id" value={campaign.id} />

  return (
    <MarketingShell active="/marketing/campaigns" title={campaign.name}
      actions={<StatusChip status={campaign.status} />}>

      <FlashBanner err={err} msg={msg} />

      <div className="mb-4 rounded-xl border border-amber-700/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
        &ldquo;Preview (dry-run)&rdquo; is <span className="font-semibold">non-destructive</span>: it never contacts anyone and never
        changes a recipient or the campaign status. SMS stays deferred. To actually send this email, use the manager-confirmed
        &ldquo;Send email (MailerLite)&rdquo; step below.
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Recipients" value={count(funnel.recipients)} />
        <StatTile label="Sent" value={count(funnel.sent)} note={`${count(funnel.excluded)} excluded`} />
        <StatTile label="Responses" value={count(funnel.responses)} />
        <StatTile label="Appointments" value={count(funnel.appointments)} />
        <StatTile label="Completed jobs" value={count(funnel.completedJobs)} />
        <StatTile label="Invoiced revenue" value={money(funnel.invoicedRevenueCents)} note="QB-anchored" />
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
              <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Preview (dry-run)</button>
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

      {isEmailCampaign && (
        <Section title="Send email (MailerLite · manual, live)">
          <p className="mb-3 text-xs text-amber-300">
            This sends to your authoritative <span className="font-semibold">MailerLite group</span> audience — NOT the {count(total)} campaign
            recipient rows above. It is a real, manager-confirmed live send (not the dry-run preview). SMS stays off.
          </p>
          {send !== '1' || !emailReady ? (
            <a href={`/marketing/campaigns/${campaign.id}?send=1`} className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700">
              Prepare to send email…
            </a>
          ) : (
            <div className="space-y-3">
              {emailReady.blockers.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-amber-200">{emailReady.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              )}
              {emailReady.contentIssues.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-amber-200">{emailReady.contentIssues.map((b) => <li key={b}>{b}</li>)}</ul>
              )}
              <div className="rounded-lg border border-gray-800 bg-gray-950 p-3 text-sm">
                <span className="text-gray-400">MailerLite audience: </span>
                {emailReady.audience?.ok
                  ? <span className="font-semibold text-emerald-300">{emailReady.audience.count} active subscriber(s) in the group</span>
                  : <span className="text-amber-300">unavailable{emailReady.audience?.error ? ` (${emailReady.audience.error})` : ''}</span>}
                <span className="text-gray-500"> · unsubscribed/inactive are rejected before sending.</span>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
                <div className="text-xs uppercase tracking-wide text-gray-500">Subject</div>
                <div className="text-sm text-white">{emailReady.subject || '—'}</div>
                <div className="mt-2 text-xs uppercase tracking-wide text-gray-500">Body (sent wrapped in branded HTML with an unsubscribe link)</div>
                <p className="mt-1 whitespace-pre-line text-sm text-gray-300">{emailReady.body || '—'}</p>
              </div>
              {emailReady.job && (
                <p className="text-xs text-gray-400">Send status: {emailReady.job.status}{emailReady.job.externalRef ? ` · ref ${emailReady.job.externalRef}` : ''}{emailReady.job.error ? ` · ${emailReady.job.error}` : ''}</p>
              )}
              {emailReady.canSend ? (
                <form action={sendCampaignEmailAction}>
                  <input type="hidden" name="id" value={campaign.id} />
                  <input type="hidden" name="confirm" value="send-email" />
                  {/* Bind the confirmation to exactly what is shown; an edit/audience change rejects it. */}
                  <input type="hidden" name="contentHash" value={emailReady.contentHash} />
                  <input type="hidden" name="audienceHash" value={emailReady.audienceHash ?? ''} />
                  <button type="submit" className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600">
                    Send email now to {emailReady.audience?.count} subscriber(s)
                  </button>
                </form>
              ) : (
                <p className="text-sm text-gray-400">Resolve the items above to enable sending. Nothing is sent until you confirm.</p>
              )}
              <p className="text-xs text-gray-500">Prerequisite: verify access to API-created HTML email on your MailerLite plan. API documentation calls this tier <span className="text-gray-300">Advanced</span>; current billing uses Power. Saved credentials alone do not verify sending readiness.</p>
            </div>
          )}
        </Section>
      )}

      <Section title="Recipients" right={<span className="text-xs text-gray-500">{count(total)} total · {count(excluded)} excluded · {count(sent)} sent</span>}>
        {total === 0 ? <EmptyRow>No recipients built yet. Use “Build recipients” to populate from the segment.</EmptyRow> : (
          <>
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
            <Pager basePath={`/marketing/campaigns/${campaign.id}`} page={page} pageSize={PAGE_SIZE} total={total} />
          </>
        )}
      </Section>
    </MarketingShell>
  )
}
