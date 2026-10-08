import Link from 'next/link'
import { redirect } from 'next/navigation'
import { managerActor } from '@/apps/checks/authz'
import { getMarketingConfig } from '@/apps/settings/db'
import { updateMarketingSettingsAction } from '../actions'
import { MarketingShell, Section, StatusChip } from '../_components'
import { getAutopilotConfig, channelBlockers } from '@/apps/marketing/autopilot-config'
import { AUTOPILOT_POLICY, SHOP_PHONE } from '@/apps/marketing/autopilot-plan'
import { listAutopilotJobs } from '@/apps/marketing/autopilot'
import { saveAutopilotAction, pauseAutopilotAction, prepareAutopilotAction, skipAutopilotAction, reviewEmailAudienceAction } from './actions'
export const dynamic='force-dynamic'
const button='rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold hover:bg-blue-500'
export default async function LaunchPage({searchParams}:{searchParams:Promise<{notice?:string}>}) {
  if(!await managerActor()) redirect('/auto-sales/login?next=/marketing/launch')
  const [cfg,items,params,marketing]=await Promise.all([getAutopilotConfig(),listAutopilotJobs(),searchParams,getMarketingConfig()])
  const email=channelBlockers(cfg,'email'),facebook=channelBlockers(cfg,'facebook')
  return <MarketingShell active="/marketing/launch" title="Launch & Autopilot" actions={<form action={pauseAutopilotAction}><button className="rounded-lg border border-red-700 px-4 py-2 text-sm">Pause autopilot</button></form>}>
    {params.notice && <p role="status" className="mb-4 rounded-xl border border-blue-800 bg-blue-950 p-3 text-sm">{params.notice}</p>}
    <Section title="Marketing workspace">
      <p className="mb-3 text-sm text-gray-300">Enable the manager workspace for manual use. This does not enable SMS, email sending, Facebook publishing, or autopilot.</p>
      {marketing.enabled ? <Link href="/marketing" className={button}>Open Marketing</Link> : <form action={updateMarketingSettingsAction}>
        <input type="hidden" name="__keys" value="marketing_enabled" />
        <input type="hidden" name="marketing_enabled" value="on" />
        <button className={button}>Enable Marketing workspace</button>
      </form>}
    </Section>
    <Section title={cfg.enabled?'Autopilot is active':'Autopilot is paused'}>
      <p className="text-sm text-gray-300">Two Facebook posts each week, on Tuesday and Friday. One email each month to the reviewed audience. The first email uses your launch date; later emails run on the 15th. Publishing runs daily around 10–11 a.m. Central, and missed dates are skipped.</p>
      <p className="mt-2 text-sm text-gray-400">General service education only. No automatic discounts, prices, appointment promises, customer stories, or job photos. SMS and advertising spend are separate and remain off for this launch.</p>
      <form action={saveAutopilotAction} className="mt-4 space-y-3">
        <label className="block text-sm">Launch date <input type="date" name="launchDate" required defaultValue={cfg.launchDate} className="ml-3 rounded bg-gray-800 p-2" /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="policy" defaultChecked={cfg.policy===AUTOPILOT_POLICY} className="mt-1"/>Allow the agent to prepare and publish within these standing rules, without approving every item.</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" name="emailLive" defaultChecked={cfg.emailLive}/>Enable monthly email when its checks pass</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" name="facebookLive" defaultChecked={cfg.facebookLive}/>Enable Facebook publishing when its checks pass</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={cfg.enabled}/>Start autopilot on the launch date</label>
        <button className={button}>Save schedule</button>
      </form>
    </Section>
    <div className="grid gap-4 md:grid-cols-2">{([{name:'Email',live:cfg.emailLive,blockers:email},{name:'Facebook',live:cfg.facebookLive,blockers:facebook}]).map(c=><Section key={c.name} title={`${c.name} · ${c.live?'enabled':'paused'}`}>
      {c.blockers.length?<ul className="list-disc space-y-2 pl-4 text-sm text-amber-200">{c.blockers.map(b=><li key={b}>{b}</li>)}</ul>:<p className="text-sm text-green-300">Launch checks passed.</p>}
      {c.name==='Email' && <p className="mt-3 text-xs text-gray-400">MailerLite must approve the account and authenticated sender. Use a dedicated group of eligible customers, preserve previous opt-outs, and verify an owner-only test before activation. No automatic imports or re-subscriptions. Verify plan access to API-created HTML email: API documentation calls the required tier <span className="text-gray-200">Advanced</span>; current billing uses Power. Trial access has not been verified.</p>}
      {c.name==='Email' && <form action={reviewEmailAudienceAction} className="mt-3 rounded-lg border border-gray-800 bg-gray-950 p-3">
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="reviewed" defaultChecked={cfg.audienceReviewed} className="mt-1"/><span>I reviewed the MailerLite group and confirm it is the intended eligible audience. Manual and monthly email send to <span className="font-semibold">that MailerLite group</span> — not Pitt Stop&apos;s customer database — and local unsubscribes/inactive records are excluded automatically on every send. This does not grant eligibility to anyone.</span></label>
        <button className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold hover:bg-blue-500">Save audience review</button>
      </form>}
      {c.name==='Facebook' && <p className="mt-3 text-xs text-gray-400">The server needs the Pitt Stop Page connection and a successful publishing test. Browser sign-in alone does not enable background posting.</p>}
    </Section>)}</div>
    <Section title="Upcoming content & history" right={<form action={prepareAutopilotAction}><button className={button}>Prepare next 45 days</button></form>}>
      <p className="mb-4 text-sm text-gray-400">Preparing drafts never publishes. The agent can rewrite them using the same facts before publishing. Accepted means the provider accepted the request; check its report for delivery. A stuck preparing/publishing item requires review and will never retry automatically.</p>
      {!items.length?<p className="text-sm">No schedule prepared yet.</p>:<div className="space-y-3">{[...items].sort((a,b)=>a.job.scheduledDate.localeCompare(b.job.scheduledDate)).map(({job,subject,emailBody,postCopy})=><article key={job.id} className="rounded-xl border border-gray-800 bg-gray-950 p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm"><strong>{job.scheduledDate} · {job.channel==='email'?'Email':'Facebook'}</strong><StatusChip status={job.status}/></div>
        {subject && <h3 className="mt-2 font-semibold">{subject}</h3>}
        <p className="mt-2 whitespace-pre-line text-sm text-gray-300">{emailBody||postCopy}</p>
        {job.error && <p className="mt-2 text-xs text-amber-300">Review needed: {job.error}</p>}
        {job.externalRef && <p className="mt-2 text-xs text-gray-400">Provider reference: {job.externalRef}</p>}
        {job.channel==='facebook' && job.status==='accepted' && job.externalRef && <Link className="mt-2 block text-sm text-blue-300" href={`https://www.facebook.com/${job.externalRef}`}>View Facebook post</Link>}
        {['planned','ready'].includes(job.status) && <form action={skipAutopilotAction} className="mt-3"><input type="hidden" name="id" value={job.id}/><button className="text-xs text-gray-400 underline">Skip this item</button></form>}
      </article>)}</div>}
    </Section>
    <p className="text-xs text-gray-500">Support shown in content: {SHOP_PHONE} · Pittstopdetailbcs@gmail.com. Provider credentials are kept on the server.</p>
  </MarketingShell>
}
