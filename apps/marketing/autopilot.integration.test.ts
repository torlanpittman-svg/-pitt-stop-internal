import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'
import {drizzle} from 'drizzle-orm/pglite'
vi.mock('@/platform/db',()=>({getDb:vi.fn()}))
vi.mock('./autopilot-config',async(importOriginal)=>({...await importOriginal<object>(),getAutopilotConfig:vi.fn()}))
vi.mock('./ai/client',()=>({aiConfigured:()=>false}))
import {getDb} from '@/platform/db'
import {getAutopilotConfig,type AutopilotConfig} from './autopilot-config'
import {AUTOPILOT_POLICY} from './autopilot-plan'
import {prepareAutopilotPlan,runAutopilot,assertAudienceAllowed} from './autopilot'
import {MailerLitePublisher,FacebookPublisher,PublishingError} from './providers/publishing'
import {GET} from '@/app/api/cron/marketing-autopilot/route'
const pg=new PGlite(),NOW=new Date('2026-10-09T16:00Z')
let cfg:AutopilotConfig
beforeAll(async()=>{
  await pg.exec('CREATE TABLE customers(id uuid PRIMARY KEY,email text,normalized_email text,active boolean DEFAULT true); CREATE TABLE service_orders(id uuid PRIMARY KEY);')
  for(const file of ['0046_marketing.sql','0047_marketing_sms_consent.sql','0048_marketing_sms_delivery.sql','0049_marketing_autopilot.sql']) await pg.exec(readFileSync(`drizzle/migrations/manual/${file}`,'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(()=>pg.close());afterEach(()=>vi.unstubAllEnvs())
beforeEach(async()=>{
  await pg.exec('TRUNCATE marketing_campaign_recipients,marketing_campaigns,marketing_social_posts,marketing_automation_jobs,marketing_events,marketing_preferences,customers CASCADE')
  cfg={enabled:true,emailLive:false,facebookLive:true,policy:AUTOPILOT_POLICY,launchDate:'2026-10-07',audienceReviewed:true,emailTestVerified:true,facebookTestVerified:true}
  vi.mocked(getAutopilotConfig).mockImplementation(async()=>({...cfg}))
  for(const [key,value] of Object.entries({CRON_SECRET:'secret',FACEBOOK_PAGE_ID:'123',FACEBOOK_PAGE_ACCESS_TOKEN:'secret',FACEBOOK_GRAPH_VERSION:'v25.0',MAILERLITE_API_TOKEN:'secret',MAILERLITE_GROUP_ID:'42',MARKETING_EMAIL_FROM:'shop@example.com'})) vi.stubEnv(key,value)
})
const facebook=()=>{const provider=new FacebookPublisher('123','secret','v25.0');const send=vi.spyOn(provider,'publish').mockResolvedValue('123_456');return{provider,send}}
async function job(date='2026-10-09'){return(await pg.query<{status:string;external_ref:string;id:string}>('SELECT * FROM marketing_automation_jobs WHERE scheduled_date=$1 AND channel=$2',[date,'facebook'])).rows[0]}
describe('durable scheduled execution',()=>{
  it('stays off without making provider requests and rejects missing/wrong cron auth',async()=>{
    const {provider,send}=facebook();cfg.enabled=false
    expect((await runAutopilot(NOW,{facebook:provider})).active).toBe(false);expect(send).not.toHaveBeenCalled()
    expect((await GET(new Request('https://local/api/cron'))).status).toBe(401)
    vi.stubEnv('CRON_SECRET','');expect((await GET(new Request('https://local/api/cron',{headers:{authorization:'Bearer secret'}}))).status).toBe(401)
  })
  it('prepares idempotent drafts without sending',async()=>{
    expect((await prepareAutopilotPlan(NOW)).added).toBeGreaterThan(0)
    expect((await prepareAutopilotPlan(NOW)).added).toBe(0)
    expect((await job()).status).toBe('planned')
  })
  it('moves only an unsent initial email when the launch date changes',async()=>{
    await prepareAutopilotPlan(new Date('2026-10-07T16:00Z'))
    cfg.launchDate='2026-10-09';await prepareAutopilotPlan(NOW)
    let row=(await pg.query<{scheduled_date:string}>("SELECT scheduled_date::text FROM marketing_automation_jobs WHERE slot_key='email:2026-10'")).rows[0]
    expect(row.scheduled_date).toBe('2026-10-09')
    await pg.exec("UPDATE marketing_automation_jobs SET status='accepted' WHERE slot_key='email:2026-10'")
    cfg.launchDate='2026-10-13';await prepareAutopilotPlan(NOW)
    row=(await pg.query<{scheduled_date:string}>("SELECT scheduled_date::text FROM marketing_automation_jobs WHERE slot_key='email:2026-10'")).rows[0]
    expect(row.scheduled_date).toBe('2026-10-09')
  })
  it('two concurrent workers and repeated runs publish exactly once',async()=>{
    await prepareAutopilotPlan(NOW);const {provider,send}=facebook()
    await Promise.all([runAutopilot(NOW,{facebook:provider}),runAutopilot(NOW,{facebook:provider})])
    await runAutopilot(NOW,{facebook:provider})
    expect(send).toHaveBeenCalledTimes(1);expect((await job()).status).toBe('accepted')
  })
  it('never catches up missed slots or sends outside the Central daytime window',async()=>{
    await prepareAutopilotPlan(new Date('2026-10-07T16:00Z'));const {provider,send}=facebook()
    await runAutopilot(new Date('2026-10-10T16:00Z'),{facebook:provider})
    expect((await job()).status).toBe('skipped');expect(send).not.toHaveBeenCalled()
    await runAutopilot(new Date('2026-10-13T06:00Z'),{facebook:provider});expect(send).not.toHaveBeenCalled()
  })
  it('leaves other channels operational when email is not connected',async()=>{
    cfg.emailLive=true;vi.stubEnv('MAILERLITE_API_TOKEN','');const {provider,send}=facebook()
    await runAutopilot(NOW,{facebook:provider});expect(send).toHaveBeenCalledTimes(1)
  })
  it('pauses after an ambiguous provider outcome with no automatic retry',async()=>{
    const {provider,send}=facebook();send.mockRejectedValue(new PublishingError('facebook_network_outcome_unknown'))
    await runAutopilot(NOW,{facebook:provider});await runAutopilot(NOW,{facebook:provider})
    expect(send).toHaveBeenCalledTimes(1);expect((await job()).status).toBe('needs_review')
  })
  it('blocks edited unsafe content and crash-left claims',async()=>{
    await prepareAutopilotPlan(NOW);const current=await job();const {provider,send}=facebook()
    await pg.query("UPDATE marketing_social_posts SET copy='We offer a free detail for every vehicle. Contact us now!' WHERE id=$1",[current.id])
    await runAutopilot(NOW,{facebook:provider});expect((await job()).status).toBe('needs_review');expect(send).not.toHaveBeenCalled()
    await pg.query("UPDATE marketing_automation_jobs SET status='publishing' WHERE id=$1",[current.id])
    await runAutopilot(NOW,{facebook:provider});expect(send).not.toHaveBeenCalled()
  })
  it('stops when paused between the claim and publication',async()=>{
    const {provider,send}=facebook();let reads=0
    vi.mocked(getAutopilotConfig).mockImplementation(async()=>({...cfg,enabled:++reads<4}))
    await runAutopilot(NOW,{facebook:provider});expect(send).not.toHaveBeenCalled()
  })
})
describe('email audience and delivery',()=>{
  const person={id:'88',email:'customer@example.com',status:'active'}
  async function customer(email=person.email){const id=randomUUID();await pg.query('INSERT INTO customers(id,email)VALUES($1,$2)',[id,email]);return id}
  it('requires a known active local customer and respects opt-out on any duplicate record',async()=>{
    await expect(assertAudienceAllowed([person])).rejects.toThrow('local_review')
    await customer();await expect(assertAudienceAllowed([person])).resolves.toBeUndefined()
    const duplicate=await customer();await pg.query('INSERT INTO marketing_preferences(customer_id,email_eligible) VALUES($1,false)',[duplicate])
    await expect(assertAudienceAllowed([person])).rejects.toThrow('local_review')
  })
  it('records provider acceptance but does not claim delivery or repeat the monthly send',async()=>{
    cfg.emailLive=true;await customer()
    const provider=new MailerLitePublisher('secret','shop@example.com','42')
    vi.spyOn(provider,'audience').mockResolvedValue([person]);vi.spyOn(provider,'createDraft').mockResolvedValue({id:'555',status:'draft'})
    const send=vi.spyOn(provider,'send').mockResolvedValue()
    const now=new Date('2026-10-07T16:00Z')
    await runAutopilot(now,{email:provider});await runAutopilot(now,{email:provider})
    expect(send).toHaveBeenCalledTimes(1)
    const row=(await pg.query<{status:string;sent_count:number}>('SELECT status,sent_count FROM marketing_campaigns WHERE name LIKE $1',['2026-10%'])).rows[0]
    expect(row.status).toBe('sending');expect(row.sent_count).toBe(0)
  })
  it('rechecks local opt-out after draft creation, before delivery',async()=>{
    cfg.emailLive=true;const id=await customer()
    const provider=new MailerLitePublisher('secret','shop@example.com','42');vi.spyOn(provider,'audience').mockResolvedValue([person])
    vi.spyOn(provider,'createDraft').mockImplementation(async()=>{await pg.query('INSERT INTO marketing_preferences(customer_id,email_eligible)VALUES($1,false)',[id]);return{id:'555',status:'draft'}})
    const send=vi.spyOn(provider,'send').mockResolvedValue()
    await runAutopilot(new Date('2026-10-07T16:00Z'),{email:provider});expect(send).not.toHaveBeenCalled()
    const row=(await pg.query<{status:string;external_ref:string}>("SELECT status,external_ref FROM marketing_automation_jobs WHERE slot_key='email:2026-10'")).rows[0]
    expect(row.status).toBe('needs_review');expect(row.external_ref).toBe('555')
  })
})
