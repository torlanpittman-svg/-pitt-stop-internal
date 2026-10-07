/** Real campaign/page APIs. No per-recipient SMTP, no account-wide email sends, no retries of POST. */
import { emailHtml, SHOP_URL } from '../autopilot-plan'
export class PublishingError extends Error {
  constructor(public code: string) { super(code) }
}
export interface Subscriber { id: string; email: string; status: string }
export interface NativeCampaign { id: string; status: string; missing_data?: unknown[]; emails?: Array<{ is_designed?: boolean }>; stats?: Record<string, unknown>; filter?: Array<Array<{operator: string; args: unknown[]}>> }
export class MailerLitePublisher {
  constructor(private token: string, private from: string, private groupId: string, private request: typeof fetch = fetch) {
    if (!token || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) || !/^\d+$/.test(groupId)) throw new PublishingError('email_configuration_missing')
  }
  private async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let r: Response
    try { r = await this.request(`https://connect.mailerlite.com/api/${path}`, { method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), cache: 'no-store' }) }
    catch { throw new PublishingError('email_network_outcome_unknown') }
    if (!r.ok) throw new PublishingError(`email_http_${r.status}`)
    try { return await r.json() as T } catch { throw new PublishingError('email_invalid_response') }
  }
  async audience(): Promise<Subscriber[]> {
    const r = await this.call<{data: Subscriber[]; meta?: {next_cursor?: string|null}}>(`groups/${this.groupId}/subscribers?filter%5Bstatus%5D=active&limit=1000`)
    if (!Array.isArray(r.data) || r.meta?.next_cursor || r.data.length > 500) throw new PublishingError('audience_exceeds_launch_limit')
    if (!r.data.length || r.data.some(s=>s.status !== 'active' || !s.id || !s.email)) throw new PublishingError('audience_empty_or_invalid')
    const emails = new Set(r.data.map(s=>s.email.trim().toLowerCase()))
    if (emails.size !== r.data.length) throw new PublishingError('audience_contains_duplicates')
    return r.data
  }
  async createDraft(key: string, subject: string, body: string): Promise<NativeCampaign> {
    const r = await this.call<{data: NativeCampaign}>('campaigns','POST',{ name: `Pitt Stop ${key}`, type: 'regular', emails: [{ from_name:'Pitt Stop Detail & Auto Sales', from:this.from, reply_to:this.from, subject, content:emailHtml(body,key) }], groups:[this.groupId] })
    if (!r.data?.id || !/^\d+$/.test(r.data.id)) throw new PublishingError('email_draft_response_invalid')
    return r.data
  }
  async campaign(id: string): Promise<NativeCampaign> {
    if (!/^\d+$/.test(id)) throw new PublishingError('email_campaign_id_invalid')
    return (await this.call<{data:NativeCampaign}>(`campaigns/${id}`)).data
  }
  async send(id: string): Promise<void> {
    const c = await this.campaign(id)
    const exactGroup = c.filter?.length === 1 && c.filter[0].length === 1 && c.filter[0][0].operator === 'in_any' && c.filter[0][0].args[0] === 'groups' && JSON.stringify(c.filter[0][0].args[1]) === JSON.stringify([this.groupId])
    if (c.status !== 'draft' || c.missing_data?.length || !c.emails?.[0]?.is_designed || !exactGroup) throw new PublishingError('email_draft_not_ready_or_audience_changed')
    await this.call(`campaigns/${id}/schedule`,'POST',{delivery:'instant'})
  }
}
export class FacebookPublisher {
  constructor(private pageId: string, private token: string, private version: string, private request: typeof fetch = fetch) {
    if (!/^\d+$/.test(pageId) || !token || !/^v\d+\.0$/.test(version)) throw new PublishingError('facebook_configuration_missing')
  }
  async verify(): Promise<string> {
    const r=await this.request(`https://graph.facebook.com/${this.version}/${this.pageId}?fields=id,name`,{headers:{Authorization:`Bearer ${this.token}`},signal:AbortSignal.timeout(10000),cache:'no-store'})
    if (!r.ok) throw new PublishingError(`facebook_http_${r.status}`)
    const data=await r.json() as {id?:string;name?:string}
    if(data.id!==this.pageId || !data.name) throw new PublishingError('facebook_page_mismatch')
    return data.name
  }
  async publish(copy: string, key: string): Promise<string> {
    let r: Response
    try { r=await this.request(`https://graph.facebook.com/${this.version}/${this.pageId}/feed`,{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify({message:copy,link:`${SHOP_URL}/?utm_source=facebook&utm_medium=organic&utm_campaign=${encodeURIComponent(key)}`}),signal:AbortSignal.timeout(15000)}) }
    catch { throw new PublishingError('facebook_network_outcome_unknown') }
    if(!r.ok) throw new PublishingError(`facebook_http_${r.status}`)
    const data=await r.json() as {id?:string}
    if(!data.id || !/^\d+_\d+$/.test(data.id)) throw new PublishingError('facebook_response_unknown')
    return data.id
  }
}
