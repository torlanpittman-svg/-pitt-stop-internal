import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createCustomerLookup, EMPTY_LOOKUP_STATE, type CustomerLookupState } from './customer-lookup'
import type { CustomerMatch } from '@/apps/quick-entry/customers'

// Minimal valid CustomerMatch for assertions.
function match(name: string): CustomerMatch {
  const [first, ...rest] = name.split(' ')
  return { name, first, last: rest.join(' '), phone: null, email: null, vehicles: [] }
}

// A fetch stub whose calls are resolved/rejected manually so we can drive the async lifecycle.
interface PendingCall { url: string; signal: AbortSignal | undefined; resolve: (r: Response) => void; reject: (e: unknown) => void }
function makeFetch() {
  const calls: PendingCall[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url: String(input), signal: init?.signal ?? undefined, resolve, reject })
    }),
  ) as unknown as typeof fetch
  return { fn, calls }
}
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}
// Flush the microtask queue so chained `.then(async …)` settles under fake timers.
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

const DEBOUNCE = 300

function setup(extra?: { minLength?: number }) {
  const states: CustomerLookupState[] = []
  const { fn, calls } = makeFetch()
  const ctrl = createCustomerLookup({
    onState: (s) => states.push(s),
    fetchImpl: fn,
    debounceMs: DEBOUNCE,
    minLength: extra?.minLength,
    endpoint: '/api/quick-entry/customers',
  })
  return { ctrl, states, calls, fetchFn: fn }
}

describe('createCustomerLookup', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts from the empty/idle state', () => {
    expect(EMPTY_LOOKUP_STATE).toEqual({ status: 'idle', query: '', matches: [], error: null, capped: false })
  })

  it('debounces the request but shows loading immediately, then resolves to ready', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('jo')
    expect(calls).toHaveLength(0)              // request is still debounced…
    expect(states.at(-1)).toMatchObject({ status: 'loading', query: 'jo', matches: [] }) // …but UI shows loading now

    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/quick-entry/customers?q=jo')
    expect(states.at(-1)?.status).toBe('loading')

    calls[0].resolve(jsonResponse({ ok: true, customers: [match('Jo Smith')] }))
    await flush()
    expect(states.at(-1)).toMatchObject({ status: 'ready', query: 'jo', error: null })
    expect(states.at(-1)?.matches).toHaveLength(1)
  })

  it('drops stale, still-selectable matches on the very next keystroke (before any new response)', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    calls[0].resolve(jsonResponse({ ok: true, customers: [match('Jo Smith')] }))
    await flush()
    expect(states.at(-1)?.matches).toHaveLength(1)  // matches are showing and selectable

    ctrl.search('john')                             // one more keystroke
    expect(states.at(-1)).toMatchObject({ status: 'loading', query: 'john', matches: [] })
    expect(states.at(-1)?.matches).toHaveLength(0)  // stale names gone synchronously, not after 300ms
  })

  it('treats a too-short query as idle and never calls fetch', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('j')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(calls).toHaveLength(0)
    expect(states).toEqual([{ status: 'idle', query: 'j', matches: [], error: null, capped: false }])
  })

  it('trims and gates on the trimmed length', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('   ')                         // whitespace only → idle, no request
    expect(states.at(-1)).toMatchObject({ status: 'idle', query: '' })
    ctrl.search('  jo ')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(calls[0].url).toBe('/api/quick-entry/customers?q=jo')
  })

  it('reports "ready" with zero matches for a real search that found nobody', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('zzz')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    calls[0].resolve(jsonResponse({ ok: true, customers: [] }))
    await flush()
    expect(states.at(-1)).toMatchObject({ status: 'ready', query: 'zzz', matches: [] })
  })

  it('passes the endpoint "capped" flag through so the UI can prompt to refine', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('mar')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    calls[0].resolve(jsonResponse({ ok: true, customers: [match('Marissa Mcquitty')], capped: true }))
    await flush()
    expect(states.at(-1)).toMatchObject({ status: 'ready', capped: true })

    ctrl.search('marissa')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    calls[1].resolve(jsonResponse({ ok: true, customers: [match('Marissa Mcquitty')] }))
    await flush()
    expect(states.at(-1)).toMatchObject({ status: 'ready', capped: false })  // narrower query → not capped
  })

  it('a newer query cancels the pending debounce so only the latest fires', async () => {
    const { ctrl, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2)   // still within debounce
    ctrl.search('john')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/quick-entry/customers?q=john')
  })

  it('aborts the in-flight request and drops its stale response when superseded', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)        // first request now in flight
    expect(calls[0].signal?.aborted).toBe(false)

    ctrl.search('john')                               // supersede → aborts the first
    expect(calls[0].signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(DEBOUNCE)        // second request fires
    expect(calls).toHaveLength(2)

    // Late resolution of the ABORTED first request must not change state.
    calls[0].resolve(jsonResponse({ ok: true, customers: [match('STALE')] }))
    await flush()
    expect(states.at(-1)?.matches.some((m) => m.name === 'STALE')).toBe(false)

    calls[1].resolve(jsonResponse({ ok: true, customers: [match('John Doe')] }))
    await flush()
    expect(states.at(-1)).toMatchObject({ status: 'ready', query: 'john' })
    expect(states.at(-1)?.matches[0].name).toBe('John Doe')
  })

  it('surfaces an error when the HTTP response is not ok', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    calls[0].resolve(jsonResponse({}, false))
    await flush()
    expect(states.at(-1)).toMatchObject({ status: 'error', query: 'jo', matches: [] })
    expect(states.at(-1)?.error).toBeTruthy()
  })

  it('surfaces an error when the payload is not { ok: true }', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    calls[0].resolve(jsonResponse({ ok: false, error: 'boom' }))
    await flush()
    expect(states.at(-1)).toMatchObject({ status: 'error', matches: [] })
  })

  it('surfaces an error on a network rejection (non-abort)', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    calls[0].reject(new TypeError('network down'))
    await flush()
    expect(states.at(-1)).toMatchObject({ status: 'error', matches: [] })
  })

  it('ignores a rejection flagged AbortError and leaves state unchanged', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    const before = states.at(-1)               // the 'loading' state
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    calls[0].reject(abortErr)
    await flush()
    expect(states.at(-1)).toBe(before)         // no further emission
  })

  it('clear() cancels a pending debounce, aborts in-flight, and returns to idle', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)        // in flight
    ctrl.clear()
    expect(calls[0].signal?.aborted).toBe(true)
    expect(states.at(-1)).toEqual({ status: 'idle', query: '', matches: [], error: null, capped: false })

    // A late response after clear() must not resurrect results.
    calls[0].resolve(jsonResponse({ ok: true, customers: [match('Jo Smith')] }))
    await flush()
    expect(states.at(-1)).toEqual({ status: 'idle', query: '', matches: [], error: null, capped: false })
  })

  it('clear() during the debounce window prevents the request entirely', async () => {
    const { ctrl, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2)
    ctrl.clear()
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(calls).toHaveLength(0)
  })

  it('dispose() stops all future emissions and in-flight handling (unmount)', async () => {
    const { ctrl, states, calls } = setup()
    ctrl.search('jo')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)        // in flight
    const emittedBefore = states.length
    ctrl.dispose()
    expect(calls[0].signal?.aborted).toBe(true)

    calls[0].resolve(jsonResponse({ ok: true, customers: [match('Jo Smith')] }))
    await flush()
    expect(states.length).toBe(emittedBefore)         // nothing emitted after dispose

    ctrl.search('john')                               // no-op after dispose
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(calls).toHaveLength(1)
    expect(states.length).toBe(emittedBefore)
  })

  it('dispose() before the debounce fires cancels the scheduled request', async () => {
    const { ctrl, calls } = setup()
    ctrl.search('jo')
    ctrl.dispose()
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(calls).toHaveLength(0)
  })
})
