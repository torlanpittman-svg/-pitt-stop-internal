import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

vi.mock('@/platform/db', () => ({ getDb: vi.fn() }))
import { getDb } from '@/platform/db'
import { handleInboundSms, handleStatusCallback } from './twilio-webhook'
import { grantSmsConsent, getPreferences } from './consent'
import { createCampaign, insertRecipients, listRecipients, markRecipient } from './db'
import { listConversations } from './comments'

const pg = new PGlite()
const PARENTS = `
  CREATE TABLE customers (id uuid PRIMARY KEY, display_name text, phone text, normalized_phone text, email text, active boolean NOT NULL DEFAULT true);
  CREATE TABLE service_orders (id uuid PRIMARY KEY, customer_id uuid, status text);
`
const cust = randomUUID()

beforeAll(async () => {
  await pg.exec(PARENTS)
  await pg.exec(readFileSync('drizzle/migrations/manual/0046_marketing.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0047_marketing_sms_consent.sql', 'utf8'))
  await pg.exec(readFileSync('drizzle/migrations/manual/0048_marketing_sms_delivery.sql', 'utf8'))
  vi.mocked(getDb).mockReturnValue(drizzle(pg) as unknown as ReturnType<typeof getDb>)
})
afterAll(() => pg.close())
beforeEach(async () => {
  await pg.exec(`DELETE FROM marketing_consent_events; DELETE FROM marketing_conversations;
    DELETE FROM marketing_campaign_recipients; DELETE FROM marketing_campaigns;
    DELETE FROM marketing_preferences; DELETE FROM marketing_events; DELETE FROM customers;`)
  await pg.query('INSERT INTO customers (id, display_name, phone, normalized_phone) VALUES ($1,$2,$3,$4)', [cust, 'Webhook Cust', '+15125550123', '5125550123'])
})

describe('inbound SMS webhook', () => {
  it('STOP immediately revokes SMS consent and sends no custom reply (Twilio handles the ack)', async () => {
    await grantSmsConsent(cust, { source: 'website_form' })
    const res = await handleInboundSms({ From: '+15125550123', Body: 'STOP', MessageSid: 'SM1' })
    expect(res.action).toBe('stop')
    expect(res.reply).toBeNull() // no double STOP response
    expect((await getPreferences(cust))?.smsConsentStatus).toBe('revoked')
  })

  it('START re-grants consent', async () => {
    const res = await handleInboundSms({ From: '+15125550123', Body: 'START', MessageSid: 'SM2' })
    expect(res.action).toBe('start')
    expect((await getPreferences(cust))?.smsConsentStatus).toBe('granted')
  })

  it('HELP replies with help text and identifies the sender', async () => {
    const res = await handleInboundSms({ From: '+15125550123', Body: 'HELP', MessageSid: 'SM3' })
    expect(res.action).toBe('help')
    expect(res.reply).toBeTruthy()
    expect(res.reply).toMatch(/stop/i)
  })

  it('a normal reply enters the conversation queue (not lost in logs)', async () => {
    const res = await handleInboundSms({ From: '+15125550123', Body: 'How much for paint correction on my F-250?', MessageSid: 'SM4' })
    expect(res.action).toBe('reply')
    const convs = await listConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0].platform).toBe('sms')
    expect(convs[0].message).toContain('paint correction')
    expect(convs[0].suggestedReply).toBeTruthy() // pricing question → condition-dependent estimate invite
  })
})

describe('delivery status webhook', () => {
  it('updates the matching recipient delivery status by provider message id', async () => {
    const camp = await createCampaign({ name: 'Status test', channel: 'sms' }, 'test')
    await insertRecipients(camp.id, [{ customerId: cust, channel: 'sms', addressSnapshot: '+15125550123', status: 'pending' }])
    const [rec] = await listRecipients(camp.id)
    await markRecipient(rec.id, { status: 'sent', providerMessageId: 'SMsent1', deliveryStatus: 'sent' })

    const ok = await handleStatusCallback({ MessageSid: 'SMsent1', MessageStatus: 'delivered' })
    expect(ok.updated).toBe(true)
    expect((await listRecipients(camp.id))[0].deliveryStatus).toBe('delivered')

    const fail = await handleStatusCallback({ MessageSid: 'SMsent1', MessageStatus: 'undelivered', ErrorCode: '30006' })
    expect(fail.updated).toBe(true)
    expect((await listRecipients(camp.id))[0].errorCode).toBe('30006')
  })

  it('ignores a status for an unknown message id', async () => {
    const res = await handleStatusCallback({ MessageSid: 'nope', MessageStatus: 'delivered' })
    expect(res.updated).toBe(false)
  })
})
