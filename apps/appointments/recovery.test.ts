/**
 * Cancelled-appointment recovery — the PURE rules: who is eligible, when emails are due, what they say, and how a
 * booking value is estimated without inventing a price. No database, no network. All customer data is fictional.
 */
import { describe, expect, it } from 'vitest'
import {
  cancelOrigin, evaluateRecovery, emailBlocker, nextSendTime, recoverySchedule, estimateValue, priorityTier, renderRecoveryEmail, isQuickCancel,
  REASONS, type RecoveryFacts,
} from './recovery'
import { DEFAULT_BOOKING_CONFIG, DEFAULT_BOOKING_SERVICES, mergeBookingConfig, zonedToUtc } from './policy'
import { isRecoveryKind, recoveryMessageStream, PostmarkEmailProvider, UNDELIVERABLE_CODES } from './notify'
import { EMAIL_CONSENT_TEXT, EMAIL_CONSENT_VERSION } from './email-consent'
import { publicBookingRoute } from './public-host'

const ON = { recoveryEmailsEnabled: true, recoveryAutoStart: true }
const facts = (over: Partial<RecoveryFacts> = {}): RecoveryFacts => ({
  appointmentStatus: 'cancelled', origin: 'customer', email: 'fictional.customer@example.com', hasCustomer: true,
  optedOut: false, emailConsent: true, otherAppointment: false, alreadyEnrolled: false, ...over,
})

describe('who cancelled', () => {
  it('an online cancel is the customer’s; a staff cancel is only customer/shop when staff said so', () => {
    expect(cancelOrigin('customer')).toBe('customer')
    expect(cancelOrigin('staff', 'customer')).toBe('customer')
    expect(cancelOrigin('staff', 'shop')).toBe('shop')
    expect(cancelOrigin('staff')).toBe('unknown')
    expect(cancelOrigin('staff', 'anything else')).toBe('unknown')
    expect(cancelOrigin(undefined)).toBe('unknown')
  })
})

describe('eligibility', () => {
  it('a customer cancellation with a deliverable, opted-in address starts automatically when both switches are on', () => {
    expect(evaluateRecovery(facts(), ON)).toEqual({ enroll: true, start: true, reason: null })
  })
  it('ships dark: with the master switch off the cancellation is queued but nothing starts', () => {
    expect(evaluateRecovery(facts(), DEFAULT_BOOKING_CONFIG)).toEqual({ enroll: true, start: false, reason: REASONS.emailsOff })
    expect(DEFAULT_BOOKING_CONFIG.recoveryEmailsEnabled).toBe(false)
    expect(DEFAULT_BOOKING_CONFIG.recoveryAutoStart).toBe(false)
  })
  it('with email allowed but auto-start off, it waits for a manager', () => {
    expect(evaluateRecovery(facts(), { recoveryEmailsEnabled: true, recoveryAutoStart: false })).toEqual({ enroll: true, start: false, reason: REASONS.manualStart })
  })
  it('never enrols a Pitt Stop cancellation', () => {
    expect(evaluateRecovery(facts({ origin: 'shop' }), ON)).toEqual({ enroll: false, reason: REASONS.shopCancelled })
  })
  it('an unknown origin goes to review — it is never assumed to be the customer’s choice', () => {
    expect(evaluateRecovery(facts({ origin: 'unknown' }), ON)).toEqual({ enroll: true, start: false, reason: REASONS.unknownOrigin })
  })
  it('no email, an invalid email, an opt-out or a missing customer record each block automatic email', () => {
    expect(evaluateRecovery(facts({ email: null }), ON)).toMatchObject({ enroll: true, start: false, reason: REASONS.noEmail })
    expect(evaluateRecovery(facts({ email: 'not-an-address' }), ON)).toMatchObject({ start: false, reason: REASONS.noEmail })
    expect(evaluateRecovery(facts({ optedOut: true }), ON)).toMatchObject({ start: false, reason: REASONS.optedOut })
    expect(evaluateRecovery(facts({ hasCustomer: false }), ON)).toMatchObject({ start: false, reason: REASONS.noCustomer })
  })
  it('being a past customer is not permission: without a recorded email opt-in nothing starts, for anyone', () => {
    expect(evaluateRecovery(facts({ emailConsent: false }), ON)).toEqual({ enroll: true, start: false, reason: REASONS.noConsent })
    expect(emailBlocker(facts({ emailConsent: false }))).toBe(REASONS.noConsent)
    // An opt-out outranks everything a customer once agreed to.
    expect(emailBlocker(facts({ emailConsent: true, optedOut: true }))).toBe(REASONS.optedOut)
  })
  it('a customer who already has another appointment is not a recovery opportunity', () => {
    expect(evaluateRecovery(facts({ otherAppointment: true }), ON)).toEqual({ enroll: false, reason: REASONS.otherAppointment })
  })
  it('a cancellation is enrolled once, and only a cancelled appointment qualifies', () => {
    expect(evaluateRecovery(facts({ alreadyEnrolled: true }), ON).enroll).toBe(false)
    expect(evaluateRecovery(facts({ appointmentStatus: 'confirmed' }), ON).enroll).toBe(false)
    expect(evaluateRecovery(facts({ appointmentStatus: 'no_show' }), ON).enroll).toBe(false)
  })
  it('emailBlocker refuses a Pitt Stop cancellation whatever the settings', () => {
    expect(emailBlocker(facts({ origin: 'shop' }))).toBe(REASONS.shopCancelled)
    expect(emailBlocker(facts())).toBeNull()
  })
})

describe('timing', () => {
  const cfg = DEFAULT_BOOKING_CONFIG
  const at = (date: string, time: string) => zonedToUtc(date, time, 'America/Chicago')
  it('defaults are 2 hours, 3 days and 7 days after the cancellation', () => {
    expect(cfg.recoveryDelayHours).toEqual([2, 72, 168])
    const [a, b, c] = recoverySchedule(at('2026-11-16', '10:00'), cfg)
    expect(a).toEqual(at('2026-11-16', '12:00'))
    expect(b).toEqual(at('2026-11-19', '10:00'))
    expect(c).toEqual(at('2026-11-23', '10:00'))
  })
  it('a late-evening cancellation is followed up the next morning, not at midnight', () => {
    // 9:32 PM cancel → +2 h = 11:32 PM, outside the 8 AM–7 PM window → 8 AM next day.
    expect(recoverySchedule(at('2026-11-15', '21:32'), cfg)[0]).toEqual(at('2026-11-16', '08:00'))
    expect(nextSendTime(at('2026-11-16', '05:10'), cfg)).toEqual(at('2026-11-16', '08:00'))
    expect(nextSendTime(at('2026-11-16', '19:00'), cfg)).toEqual(at('2026-11-17', '08:00'))
    expect(nextSendTime(at('2026-11-16', '18:59'), cfg)).toEqual(at('2026-11-16', '18:59'))
  })
  it('delays are configurable, and a nonsense setting falls back to the defaults instead of sending early', () => {
    expect(mergeBookingConfig({ recoveryDelayHours: [4, 48, 240] }).recoveryDelayHours).toEqual([4, 48, 240])
    expect(mergeBookingConfig({ recoveryDelayHours: [72, 2, 168] }).recoveryDelayHours).toEqual([2, 72, 168])
    expect(mergeBookingConfig({ recoveryDelayHours: [0, 1, 2] }).recoveryDelayHours).toEqual([2, 72, 168])
    expect(mergeBookingConfig({ recoveryDelayHours: 'soon' }).recoveryDelayHours).toEqual([2, 72, 168])
    const odd = mergeBookingConfig({ recoverySendStartHour: 20, recoverySendEndHour: 6 })
    expect([odd.recoverySendStartHour, odd.recoverySendEndHour]).toEqual([8, 19])
  })
  it('a stored config from before this feature has recovery off', () => {
    const old = mergeBookingConfig({ enabled: true, confirmationEnabled: true })
    expect(old.recoveryEmailsEnabled).toBe(false)
    expect(old.recoveryAutoStart).toBe(false)
  })
})

describe('estimated booking value — real catalog prices only', () => {
  const prices = new Map<string, number | null>([
    ['ceramic_coating_1yr', 100000], ['ceramic_coating_3yr', 220000], ['interior_detail', null], ['mini_detail', 15000], ['paint_correction_1step', 65000],
  ])
  it('PS-BFJAJM shape: ceramic coating gives a floor; size-priced and unpriced services are listed, not guessed', () => {
    const v = estimateValue(['interior_detail', 'ceramic_coating', 'odor'], DEFAULT_BOOKING_SERVICES, prices)
    expect(v.minCents).toBe(100000)
    expect(v.priced).toEqual([{ label: 'Ceramic Coating', cents: 100000, from: true }])
    expect(v.unpriced).toEqual(['Interior Detail', 'Odor / Ozone'])
  })
  it('a fixed-price catalog service is exact', () => {
    expect(estimateValue(['mini_detail'], DEFAULT_BOOKING_SERVICES, prices)).toEqual({ minCents: 15000, priced: [{ label: 'Mini Detail', cents: 15000, from: false }], unpriced: [] })
  })
  it('no price data means no value at all — never zero, never invented', () => {
    expect(estimateValue(['interior_detail', 'odor', 'other'], DEFAULT_BOOKING_SERVICES, prices).minCents).toBeNull()
    expect(estimateValue(['ceramic_coating'], DEFAULT_BOOKING_SERVICES, new Map()).minCents).toBeNull()
  })
  it('ceramic coating and paint correction outrank the detail packages', () => {
    expect(priorityTier(['odor', 'ceramic_coating'])).toBe(3)
    expect(priorityTier(['paint_correction'])).toBe(3)
    expect(priorityTier(['complete_detail'])).toBe(2)
    expect(priorityTier(['mini_detail'])).toBe(1)
    expect(priorityTier([])).toBe(1)
  })
})

describe('email copy', () => {
  const a = { firstName: 'Fictional', vehicleYear: '2019', vehicleMake: 'Ford', vehicleModel: 'F-150', serviceLabels: 'Interior Detail, Ceramic Coating, Odor / Ozone' }
  const links = { rebook: 'https://book.example.test/book/c/TOKEN', unsubscribe: 'https://book.example.test/unsubscribe/abc' }
  const cfg = { phone: '(979) 696-6640', address: '3112 Texas Ave S, College Station, TX 77845' }
  it('the three subjects are the owner’s wording', () => {
    expect(renderRecoveryEmail(1, a, cfg, links).subject).toBe('Need to reschedule your appointment?')
    expect(renderRecoveryEmail(2, a, cfg, links).subject).toBe('Still interested in getting your 2019 Ford F-150 taken care of?')
    expect(renderRecoveryEmail(3, a, cfg, links).subject).toBe('We’re here whenever you’re ready')
  })
  it('email 1 names the vehicle and carries the rebooking link', () => {
    const e = renderRecoveryEmail(1, a, cfg, links)
    expect(e.text).toContain('Hi Fictional,')
    expect(e.text).toContain('We noticed your appointment for your 2019 Ford F-150 was canceled.')
    expect(e.text).toContain(links.rebook)
    expect(e.html).toContain(links.rebook)
  })
  it('email 2 names the services that were scheduled', () => {
    expect(renderRecoveryEmail(2, a, cfg, links).text).toContain('the Interior Detail, Ceramic Coating, Odor / Ozone you had scheduled for your 2019 Ford F-150')
  })
  it('every email identifies the sender, gives the postal address and a working opt-out', () => {
    for (const step of [1, 2, 3] as const) {
      const e = renderRecoveryEmail(step, a, cfg, links)
      for (const body of [e.text, e.html]) {
        expect(body).toContain('Pitt Stop Detail &')
        expect(body).toContain('3112 Texas Ave S')
        expect(body).toContain(links.unsubscribe)
      }
      expect(e.headers).toEqual([{ name: 'List-Unsubscribe', value: `<${links.unsubscribe}>` }])
    }
  })
  it('cancelled within five minutes of booking: email 1 offers help instead of a reschedule; emails 2 and 3 are unchanged', () => {
    const t = (s: string) => new Date(`2026-11-16T03:${s}Z`)
    expect(isQuickCancel({ createdAt: t('32:36'), cancelledAt: t('32:52') })).toBe(true)   // PS-BFJAJM: 16 seconds
    expect(isQuickCancel({ createdAt: t('30:00'), cancelledAt: t('35:00') })).toBe(true)   // exactly five minutes
    expect(isQuickCancel({ createdAt: t('30:00'), cancelledAt: t('35:01') })).toBe(false)
    expect(isQuickCancel({ createdAt: t('30:00'), cancelledAt: null })).toBe(false)
    const soft = renderRecoveryEmail(1, a, cfg, links, { quick: true })
    expect(soft.subject).toBe('Need a hand with your booking?')
    expect(soft.text).toContain('was canceled shortly after you booked it')
    expect(soft.text).toContain('just reply to this email or call us at (979) 696-6640')
    expect(soft.text).toContain(links.rebook)
    expect(soft.text).toContain(links.unsubscribe)
    expect(soft.html).toContain('3112 Texas Ave S')
    expect(renderRecoveryEmail(1, a, cfg, links).subject).toBe('Need to reschedule your appointment?')
    for (const step of [2, 3] as const) expect(renderRecoveryEmail(step, a, cfg, links, { quick: true })).toEqual(renderRecoveryEmail(step, a, cfg, links))
  })
  it('missing details fall back to plain words, never a blank or a placeholder', () => {
    const e = renderRecoveryEmail(1, { firstName: '', vehicleYear: null, vehicleMake: null, vehicleModel: null, serviceLabels: '' }, cfg, links)
    expect(e.text).toContain('Hi,')
    expect(e.text).toContain('your appointment for your vehicle was canceled')
    expect(e.text).not.toMatch(/\[|undefined|null/)
  })
  it('customer text is escaped in the HTML', () => {
    expect(renderRecoveryEmail(1, { ...a, firstName: '<b>x</b>' }, cfg, links).html).not.toContain('<b>x</b>')
  })
})

describe('Postmark streams', () => {
  const capture = () => {
    const calls: Record<string, unknown>[] = []
    const fetchImpl = (async (_u: unknown, init?: { body?: unknown }) => { calls.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'm1' }), { status: 200 }) }) as unknown as typeof fetch
    return { calls, provider: new PostmarkEmailProvider('token', 'from@example.com', fetchImpl) }
  }
  it('recovery emails default to the broadcast stream; an env override is honoured', () => {
    expect(recoveryMessageStream({} as NodeJS.ProcessEnv)).toBe('broadcast')
    expect(recoveryMessageStream({ APPOINTMENT_RECOVERY_MESSAGE_STREAM: ' recovery-followups ' } as unknown as NodeJS.ProcessEnv)).toBe('recovery-followups')
  })
  it('booking notices still go on the transactional stream with no extra headers — unchanged', async () => {
    const { calls, provider } = capture()
    await provider.send({ to: 'c@example.com', subject: 's', text: 't' })
    expect(calls[0].MessageStream).toBe('outbound')
    expect(calls[0].Headers).toBeUndefined()
  })
  it('a recovery email is sent on the broadcast stream with its List-Unsubscribe header', async () => {
    const { calls, provider } = capture()
    await provider.send({ to: 'c@example.com', subject: 's', text: 't', messageStream: recoveryMessageStream({} as NodeJS.ProcessEnv), headers: [{ name: 'List-Unsubscribe', value: '<https://x.test/u>' }] })
    expect(calls[0].MessageStream).toBe('broadcast')
    expect(calls[0].Headers).toEqual([{ Name: 'List-Unsubscribe', Value: '<https://x.test/u>' }])
  })
  it('a rejection carries Postmark’s code, so a setup fault is never mistaken for a dead address', async () => {
    const reject = (ErrorCode: number) => new PostmarkEmailProvider('t', 'f@example.com', (async () => new Response(JSON.stringify({ ErrorCode, Message: 'no' }), { status: 422 })) as unknown as typeof fetch)
    const inactive = await reject(406).send({ to: 'c@example.com', subject: 's', text: 't' })
    const noStream = await reject(1235).send({ to: 'c@example.com', subject: 's', text: 't' })
    expect(inactive).toMatchObject({ status: 'failed', retryable: false, code: 406 })
    expect(noStream).toMatchObject({ status: 'failed', retryable: false, code: 1235 })
    expect(UNDELIVERABLE_CODES.includes(406) && UNDELIVERABLE_CODES.includes(300)).toBe(true)
    expect(UNDELIVERABLE_CODES.includes(1235)).toBe(false)
  })
})

describe('email-marketing consent wording', () => {
  it('is versioned, says what it allows, and that it can be withdrawn', () => {
    expect(EMAIL_CONSENT_VERSION).toMatch(/^booking-email-marketing-v\d/)
    expect(EMAIL_CONSENT_TEXT).toContain('Email me')
    expect(EMAIL_CONSENT_TEXT).toContain('unsubscribe')
  })
})

describe('plumbing', () => {
  it('only recovery_1..3 are recovery kinds — booking notices never take the recovery path', () => {
    expect(['recovery_1', 'recovery_2', 'recovery_3'].every(isRecoveryKind)).toBe(true)
    expect(['confirmation', 'reminder', 'reschedule', 'cancellation', 'recovery_4', 'recovery', 'xrecovery_1'].some(isRecoveryKind)).toBe(false)
  })
  it('the booking host serves the recovery link and the unsubscribe page, and still nothing internal', () => {
    const t = 'A'.repeat(32)
    expect(publicBookingRoute(`/book/c/${t}`, 'GET')).toBe('allow')
    expect(publicBookingRoute(`/book/c/${t}`, 'POST')).toBe('deny')
    expect(publicBookingRoute('/unsubscribe/3f0c2a4e-1b2c-4d5e-8f90-123456789abc', 'GET')).toBe('allow')
    expect(publicBookingRoute('/unsubscribe/3f0c2a4e-1b2c-4d5e-8f90-123456789abc', 'POST')).toBe('allow')
    expect(publicBookingRoute('/unsubscribe/not-a-token', 'GET')).toBe('deny')
    expect(publicBookingRoute('/appointments/recovery', 'GET')).toBe('deny')
    expect(publicBookingRoute(`/book/x/${t}`, 'GET')).toBe('deny')
  })
})
