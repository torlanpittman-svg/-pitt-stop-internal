/**
 * The quick-sticker request lifecycle — the rules that stop a lost response from turning into a
 * second physical sticker. Pure functions, no React, no network.
 */
import { describe, it, expect } from 'vitest'
import {
  beginRequest, canMintNewRequest, isResolved, markUnknown, markUnsent, planQuickAction,
  postFailureOutcome, restoreRecord, withJob, type QuickJobView, type QuickRequestRecord,
} from './oil-sticker-quick-state'

const VALUES = { mileage: 187781, intervalMiles: 5000, intervalMonths: 6, nextMileage: 192781, nextDate: '2027-04-30' }
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const job = (status: string, over: Partial<QuickJobView> = {}): QuickJobView =>
  ({ jobId: A, status, error: null, uncertain: false, createdAt: '2026-10-30T12:00:00.000Z', ...over })

const plan = (record: QuickRequestRecord | null, over: { canPrint?: boolean; busy?: boolean; booting?: boolean } = {}) =>
  planQuickAction({ record, canPrint: over.canPrint ?? true, busy: over.busy ?? false, booting: over.booting ?? false })

describe('a request is recorded before it is dispatched', () => {
  it('starts as pending with NO job — it never borrows an earlier outcome', () => {
    const rec = beginRequest('tony', A, VALUES)
    expect(rec).toMatchObject({ v: 2, actorKey: 'tony', requestId: A, state: 'pending', job: null })
    expect(isResolved(rec)).toBe(false)
    expect(canMintNewRequest(rec)).toBe(false)
  })

  it('the submitted values are immutable through every outcome', () => {
    const rec = beginRequest('tony', A, VALUES)
    for (const next of [markUnknown(rec), markUnsent(rec), withJob(rec, job('submitted'))]) {
      expect(next.values).toEqual(VALUES)
      expect(next.requestId).toBe(A)
    }
  })
})

describe('recovery after a lost response (the duplicate-print hole)', () => {
  it('a reload mid-flight comes back as UNKNOWN, and the only offer is a status check', () => {
    const dispatched = beginRequest('tony', A, VALUES)
    const restored = restoreRecord(JSON.stringify(dispatched), 'tony')!
    expect(restored.state).toBe('unknown')
    expect(restored.job).toBeNull()
    expect(canMintNewRequest(restored)).toBe(false)
    expect(plan(restored)).toMatchObject({ kind: 'check', requestId: A, disabled: false, canStartNew: false, fieldsLocked: true })
  })

  it('a SECOND copy whose response is lost cannot resurrect the FIRST copy’s success', () => {
    // First copy printed fine…
    const first = withJob(beginRequest('tony', A, VALUES), job('submitted'))
    expect(plan(first)).toMatchObject({ kind: 'print', canStartNew: true })
    // …then "Print another copy" is tapped and the response is lost.
    const second = beginRequest('tony', B, VALUES)
    const restored = restoreRecord(JSON.stringify(second), 'tony')!
    // The restored record is the SECOND request, unresolved — not the first one's 'submitted' job.
    expect(restored.requestId).toBe(B)
    expect(restored.job).toBeNull()
    expect(plan(restored).kind).toBe('check')
    expect(canMintNewRequest(restored)).toBe(false)
  })

  it('a 404 is NOT proof that nothing printed: the retry reuses the SAME token', () => {
    const unsent = markUnsent(beginRequest('tony', A, VALUES))
    const p = plan(unsent)
    expect(p).toMatchObject({ kind: 'resend', requestId: A, canStartNew: false, fieldsLocked: true })
    expect(canMintNewRequest(unsent)).toBe(false)
  })

  it('"Start a new sticker" is offered only for a RESOLVED request', () => {
    const rec = beginRequest('tony', A, VALUES)
    expect(plan(rec).canStartNew).toBe(false)                         // pending
    expect(plan(markUnknown(rec)).canStartNew).toBe(false)            // unknown dispatch
    expect(plan(markUnsent(rec)).canStartNew).toBe(false)             // maybe still in flight
    expect(plan(withJob(rec, job('queued'))).canStartNew).toBe(false) // on its way
    expect(plan(withJob(rec, job('failed'))).canStartNew).toBe(true)  // resolved
  })
})

describe('what the primary button may do', () => {
  it('nothing recorded → print, but only once the values make a sticker', () => {
    expect(plan(null)).toMatchObject({ kind: 'print', requestId: null, label: 'Print Oil Change Sticker', disabled: false })
    expect(plan(null, { canPrint: false }).disabled).toBe(true)
    expect(plan(null, { busy: true }).disabled).toBe(true)
  })

  it('a job still on its way is a disabled, honest "on its way" — never a resend', () => {
    for (const status of ['queued', 'claimed']) {
      const p = plan(withJob(beginRequest('tony', A, VALUES), job(status)))
      expect(p).toMatchObject({ kind: 'wait', disabled: true, fieldsLocked: true })
    }
  })

  it('a resolved job offers a NEW deliberate request, worded for what happened', () => {
    const rec = beginRequest('tony', A, VALUES)
    expect(plan(withJob(rec, job('submitted'))).label).toBe('Print another copy')
    for (const status of ['failed', 'expired', 'canceled']) {
      expect(plan(withJob(rec, job(status)))).toMatchObject({ kind: 'print', label: 'Send again', canStartNew: true })
    }
  })

  it('while the form is still loading, nothing is actionable', () => {
    expect(plan(null, { booting: true })).toMatchObject({ kind: 'wait', disabled: true, fieldsLocked: true })
  })

  it('the fields stay locked for every unresolved request, and unlock when it is resolved', () => {
    const rec = beginRequest('tony', A, VALUES)
    expect(plan(rec).fieldsLocked).toBe(true)
    expect(plan(markUnknown(rec)).fieldsLocked).toBe(true)
    expect(plan(markUnsent(rec)).fieldsLocked).toBe(true)
    expect(plan(withJob(rec, job('claimed'))).fieldsLocked).toBe(true)
    expect(plan(withJob(rec, job('submitted'))).fieldsLocked).toBe(false)
  })
})

describe('restoreRecord refuses anything that is not this actor’s own record', () => {
  const rec = withJob(beginRequest('tony', A, VALUES), job('queued'))

  it('ignores another actor’s saved request entirely', () => {
    expect(restoreRecord(JSON.stringify(rec), 'darryl')).toBeNull()
    expect(restoreRecord(JSON.stringify(rec), '')).toBeNull()
  })

  it('ignores junk, old versions, and records missing their values', () => {
    expect(restoreRecord('not json', 'tony')).toBeNull()
    expect(restoreRecord(null, 'tony')).toBeNull()
    expect(restoreRecord(JSON.stringify({ ...rec, v: 1 }), 'tony')).toBeNull()
    expect(restoreRecord(JSON.stringify({ ...rec, requestId: '' }), 'tony')).toBeNull()
    expect(restoreRecord(JSON.stringify({ ...rec, values: { mileage: 1 } }), 'tony')).toBeNull()
    expect(restoreRecord(JSON.stringify({ ...rec, job: { nope: true } }), 'tony')).toBeNull()
  })

  it('keeps a tracked job, and keeps "unsent" re-sendable with its own token', () => {
    expect(restoreRecord(JSON.stringify(rec), 'tony')).toMatchObject({ state: 'tracked', job: { status: 'queued' } })
    const unsent = markUnsent(beginRequest('tony', A, VALUES))
    expect(restoreRecord(JSON.stringify(unsent), 'tony')).toMatchObject({ state: 'unsent', requestId: A })
  })

  it('a "tracked" record with no job is not trusted as tracked', () => {
    const broken = { ...rec, job: null }
    expect(restoreRecord(JSON.stringify(broken), 'tony')).toMatchObject({ state: 'unknown', job: null })
  })
})

describe('postFailureOutcome — only a provable pre-write refusal clears the token', () => {
  it('refusals that happen before the insert are safe to retry/correct', () => {
    for (const code of ['bad_mileage', 'bad_interval_miles', 'bad_interval_months', 'bad_next_mileage', 'bad_next_date', 'bad_request_id']) {
      expect(postFailureOutcome(422, code)).toBe('not_dispatched')
    }
    expect(postFailureOutcome(400, 'invalid_body')).toBe('not_dispatched')
    expect(postFailureOutcome(400, 'invalid_json')).toBe('not_dispatched')
  })
  it('a 5xx, an unlabelled 422, or a dropped request is UNKNOWN', () => {
    expect(postFailureOutcome(500, null)).toBe('unknown')
    expect(postFailureOutcome(503, 'whatever')).toBe('unknown')
    expect(postFailureOutcome(422, 'enqueue_failed')).toBe('unknown')
    expect(postFailureOutcome(0, null)).toBe('unknown')
  })
  it('auth and token conflicts are their own answers', () => {
    expect(postFailureOutcome(401, null)).toBe('unauthorized')
    expect(postFailureOutcome(409, 'request_id_conflict')).toBe('conflict')
  })
})
