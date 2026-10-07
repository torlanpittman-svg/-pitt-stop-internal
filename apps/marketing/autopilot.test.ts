import { describe,expect,it,vi,afterEach } from 'vitest'
import { AUTOPILOT_POLICY,planSlots,localDate,safeAutonomousCopy,emailHtml } from './autopilot-plan'
import { channelBlockers,type AutopilotConfig } from './autopilot-config'
import { MailerLitePublisher,FacebookPublisher } from './providers/publishing'
const NOW=new Date('2026-10-07T16:00:00Z')
afterEach(()=>vi.unstubAllEnvs())
describe('standing cadence',()=>{
  it('plans exactly one monthly email, never more than two Facebook posts per week',()=>{
    const slots=planSlots('2026-10-07',NOW,62)
    for(const month of ['2026-10','2026-11']) expect(slots.filter(s=>s.channel==='email'&&s.date.startsWith(month))).toHaveLength(1)
    expect(slots.filter(s=>s.channel==='facebook').every(s=>[2,5].includes(new Date(s.date).getUTCDay()))).toBe(true)
    expect(slots.filter(s=>s.channel==='facebook'&&s.date.startsWith('2026-10'))).toHaveLength(7)
    expect(new Set(slots.map(s=>s.id)).size).toBe(slots.length)
  })
  it('stable month IDs prevent a second email after launch date changes',()=>{
    const a=planSlots('2026-10-07',NOW).find(s=>s.channel==='email')!
    const b=planSlots('2026-10-09',NOW).find(s=>s.channel==='email')!
    expect(a.id).toBe(b.id)
  })
  it('does not generate a backlog and handles local midnight/DST',()=>{
    expect(planSlots('2026-10-07',new Date('2026-10-20T16:00Z')).every(s=>s.date>='2026-10-20')).toBe(true)
    expect(localDate(new Date('2026-11-02T04:00:00Z'))).toBe('2026-11-01')
    expect(()=>planSlots('2026-02-30',NOW)).toThrow()
  })
  it('only permits safe factual templates and escapes HTML with an unsubscribe footer',()=>{
    for(const s of planSlots('2026-10-07',NOW,62)) expect(safeAutonomousCopy(s.subject,s.body)).toBe(true)
    for(const bad of ['Book a $50 detail while available this week.','We restored this customer car and offer free coatings!','Contact https://wrong.example for your next service.']) expect(safeAutonomousCopy('',bad)).toBe(false)
    const html=emailHtml('<script>bad</script>', 'email:2026-10')
    expect(html).not.toContain('<script>');expect(html).toContain('{$unsubscribe}');expect(html).toContain('3112 Texas');expect(html).toContain('United States')
  })
})
const ready:AutopilotConfig={enabled:true,emailLive:true,facebookLive:true,policy:AUTOPILOT_POLICY,launchDate:'2026-10-07',audienceReviewed:true,emailTestVerified:true,facebookTestVerified:true}
it('requires independently verified channels and protects an absent scheduler secret',()=>{
  const env={CRON_SECRET:'test',FACEBOOK_PAGE_ACCESS_TOKEN:'test',FACEBOOK_PAGE_ID:'1',FACEBOOK_GRAPH_VERSION:'v25.0'}
  expect(channelBlockers(ready,'facebook',env)).toEqual([])
  expect(channelBlockers(ready,'email',env).join()).toContain('MailerLite')
  expect(channelBlockers(ready,'facebook',{}).join()).toContain('scheduler')
  expect(channelBlockers({...ready,facebookTestVerified:false},'facebook',env).join()).toContain('Verify')
})
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}})
const campaign={id:'123',status:'draft',missing_data:[],emails:[{is_designed:true}],filter:[[{operator:'in_any',args:['groups',['42']]}]]}
describe('provider boundaries',()=>{
  it('creates a group-scoped email with a verified sender and no automatic imports',async()=>{
    const request=vi.fn<typeof fetch>().mockResolvedValue(json({data:campaign}))
    const p=new MailerLitePublisher('secret','shop@example.com','42',request)
    await p.createDraft('email:2026-10','Subject','Email body')
    const [url,options]=request.mock.calls[0], body=JSON.parse(String(options?.body))
    expect(url).toBe('https://connect.mailerlite.com/api/campaigns');expect(body.groups).toEqual(['42']);expect(body.emails[0].content).toContain('{$unsubscribe}')
    expect(String(url)).not.toContain('secret')
  })
  it('refuses account-wide or changed audience and undesigned campaigns',async()=>{
    for(const changed of [{...campaign,filter:[]},{...campaign,status:'sent'},{...campaign,missing_data:['content']},{...campaign,emails:[]}]){
      const request=vi.fn<typeof fetch>().mockResolvedValue(json({data:changed}))
      await expect(new MailerLitePublisher('secret','shop@example.com','42',request).send('123')).rejects.toThrow('not_ready')
      expect(request).toHaveBeenCalledTimes(1)
    }
  })
  it('schedules only the verified exact group campaign',async()=>{
    const request=vi.fn<typeof fetch>().mockResolvedValueOnce(json({data:campaign})).mockResolvedValueOnce(json({data:campaign}))
    await new MailerLitePublisher('secret','shop@example.com','42',request).send('123')
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({delivery:'instant'})
  })
  it('refuses inactive, duplicate, paginated or oversized audiences',async()=>{
    const person={id:'1',email:'a@example.com',status:'active'}
    for(const result of [{data:[{...person,status:'unsubscribed'}]},{data:[person,person]},{data:[person],meta:{next_cursor:'next'}},{data:Array(501).fill(person)},{data:[]}]){
      const request=vi.fn<typeof fetch>().mockResolvedValue(json(result))
      await expect(new MailerLitePublisher('secret','shop@example.com','42',request).audience()).rejects.toThrow()
    }
  })
  it('does not retry an ambiguous post or leak token/provider error',async()=>{
    const request=vi.fn<typeof fetch>().mockRejectedValue(new Error('private token details'))
    await expect(new FacebookPublisher('123','secret','v25.0',request).publish('Copy','key')).rejects.toThrow('facebook_network_outcome_unknown')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('checks the Page identity and records only a valid post reference',async()=>{
    const request=vi.fn<typeof fetch>().mockResolvedValueOnce(json({id:'123',name:'Pitt Stop'})).mockResolvedValueOnce(json({id:'123_456'}))
    const p=new FacebookPublisher('123','secret','v25.0',request)
    expect(await p.verify()).toBe('Pitt Stop');expect(await p.publish('Copy','key')).toBe('123_456')
    expect(String(request.mock.calls[1][0])).not.toContain('secret')
  })
})
