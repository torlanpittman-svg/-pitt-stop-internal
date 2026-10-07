import { getAllSettings } from '@/apps/settings/db'
import { AUTOPILOT_POLICY, validDate } from './autopilot-plan'
export interface AutopilotConfig { enabled: boolean; emailLive: boolean; facebookLive: boolean; policy: string; launchDate: string; audienceReviewed: boolean; emailTestVerified: boolean; facebookTestVerified: boolean }
export async function getAutopilotConfig(): Promise<AutopilotConfig> {
  const rows=await getAllSettings(), map=new Map(rows.map(r=>[r.key,r.value]))
  return { enabled:map.get('marketing_autopilot_enabled')===true, emailLive:map.get('marketing_email_live')===true, facebookLive:map.get('marketing_facebook_live')===true, policy:String(map.get('marketing_autopilot_policy')??''), launchDate:String(map.get('marketing_launch_date')??'2026-10-07'), audienceReviewed:map.get('marketing_email_audience_reviewed')===true, emailTestVerified:map.get('marketing_email_test_verified')===true, facebookTestVerified:map.get('marketing_facebook_test_verified')===true }
}
export function channelBlockers(cfg: AutopilotConfig, channel: 'email'|'facebook', env: Record<string,string|undefined>=process.env): string[] {
  const result:string[]=[]
  if(!validDate(cfg.launchDate)) result.push('Choose a valid launch date')
  if(cfg.policy!==AUTOPILOT_POLICY) result.push('Approve the standing content rules')
  if(!env.CRON_SECRET) result.push('Connect the protected scheduler')
  if(channel==='email') {
    if(!env.MAILERLITE_API_TOKEN || !env.MAILERLITE_GROUP_ID || !env.MARKETING_EMAIL_FROM) result.push('Connect MailerLite and a verified sender')
    if(!cfg.audienceReviewed) result.push('Review the email audience and previous opt-outs')
    if(!cfg.emailTestVerified) result.push('Verify the owner test email and unsubscribe link')
  } else {
    if(!env.FACEBOOK_PAGE_ACCESS_TOKEN || !env.FACEBOOK_PAGE_ID || !env.FACEBOOK_GRAPH_VERSION) result.push('Connect the Facebook Page')
    if(!cfg.facebookTestVerified) result.push('Verify Facebook publishing permissions')
  }
  return result
}
