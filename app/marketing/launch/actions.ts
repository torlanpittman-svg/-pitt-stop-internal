'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { and, eq, inArray } from 'drizzle-orm'
import { managerActor } from '@/apps/checks/authz'
import { updateSetting } from '@/apps/settings/db'
import { getAutopilotConfig, channelBlockers } from '@/apps/marketing/autopilot-config'
import { AUTOPILOT_POLICY, localDate, validDate } from '@/apps/marketing/autopilot-plan'
import { prepareAutopilotPlan } from '@/apps/marketing/autopilot'
import { marketingAutomationJobs } from '@/apps/marketing/schema'
import { getDb } from '@/platform/db'
import { logEvent } from '@/apps/marketing/events'

async function actor() {
  const user=await managerActor()
  if(!user) redirect('/auto-sales/login?next=/marketing/launch')
  return user.name
}
function finish(message:string):never {
  revalidatePath('/marketing/launch')
  redirect(`/marketing/launch?notice=${encodeURIComponent(message)}`)
}
export async function saveAutopilotAction(form:FormData) {
  const name=await actor(), cfg=await getAutopilotConfig()
  const date=String(form.get('launchDate')??'')
  const enabled=form.get('enabled')==='on',emailLive=form.get('emailLive')==='on',facebookLive=form.get('facebookLive')==='on'
  if(!validDate(date)) finish('Choose a valid launch date.')
  if(enabled && date<localDate(new Date())) finish('Choose today or a future launch date before starting.')
  const policy=form.get('policy')==='on'?AUTOPILOT_POLICY:''
  const next={...cfg,launchDate:date,enabled,emailLive,facebookLive,policy}
  const blockers=[...(emailLive?channelBlockers(next,'email'):[]),...(facebookLive?channelBlockers(next,'facebook'):[])]
  if(enabled && !emailLive && !facebookLive) blockers.push('Choose a ready channel before starting.')
  if(blockers.length) finish([...new Set(blockers)].join(' · '))
  // Pause first: a worker sees either the old complete configuration or a safe paused transition.
  await updateSetting('marketing_autopilot_enabled',false,name)
  for(const [key,value] of Object.entries({marketing_launch_date:date,marketing_autopilot_policy:policy,marketing_email_live:emailLive,marketing_facebook_live:facebookLive})) await updateSetting(key,value,name)
  await prepareAutopilotPlan()
  await updateSetting('marketing_autopilot_enabled',enabled,name)
  await logEvent('automation_settings_changed',{entityType:'automation',actor:name,meta:{enabled,emailLive,facebookLive,date,policy}})
  finish(enabled?'Autopilot is active for the selected channels.':'Schedule saved. Autopilot is paused.')
}
export async function pauseAutopilotAction() {
  const name=await actor()
  await updateSetting('marketing_autopilot_enabled',false,name)
  await logEvent('automation_settings_changed',{entityType:'automation',actor:name,meta:{enabled:false}})
  finish('Autopilot paused. A provider request already accepted may still complete.')
}
export async function prepareAutopilotAction() {
  await actor()
  const result=await prepareAutopilotPlan()
  finish(`${result.added} drafts added. Nothing was sent or published.`)
}
export async function skipAutopilotAction(form:FormData) {
  const name=await actor(),id=String(form.get('id')??'')
  if(!/^[0-9a-f-]{36}$/i.test(id)) finish('Invalid schedule item.')
  const changed=await getDb().update(marketingAutomationJobs).set({status:'skipped',error:'Skipped by manager',updatedAt:new Date()})
    .where(and(eq(marketingAutomationJobs.id,id),inArray(marketingAutomationJobs.status,['planned','ready']))).returning({id:marketingAutomationJobs.id})
  if(changed.length) await logEvent('automation_settings_changed',{entityType:'automation',entityId:id,actor:name,meta:{status:'skipped'}})
  finish(changed.length?'Item skipped.':'This item is already processing or finished; inspect the provider before changing it.')
}
