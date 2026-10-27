/**
 * Shared returning-customer lookup controller.
 *
 * One debounced, abortable search over the EXISTING read-only endpoint
 * `GET /api/quick-entry/customers?q=…` (directory + Quick Entry history fallback). Used by
 * both the detailed Retail Estimator intake and Quick Entry so "look up a customer by name or
 * phone" behaves identically everywhere. No DB/schema/backend changes — this is a client helper.
 *
 * Framework-agnostic on purpose (plain timers + fetch + an AbortController) so the async
 * lifecycle is unit-testable with fake timers and a mocked fetch, with no DOM. The React wrapper
 * lives in `app/components/useCustomerLookup.ts`.
 *
 * Staleness/lifecycle guarantees (every one matters for a shop phone on a flaky connection):
 *  - A newer keystroke supersedes an older one: the pending debounce is cancelled, any in-flight
 *    request is aborted, and a late/stale response is dropped via a monotonic version guard.
 *  - A too-short query (or clear/select/dismiss) returns to `idle` and never shows old results.
 *  - After `dispose()` (unmount) nothing is emitted and no request/timer is left running.
 *  - Both the HTTP status (`res.ok`) AND the payload shape (`{ ok: true, customers: [] }`) are
 *    validated; anything else surfaces as a non-fatal error so manual entry still works.
 */
import type { CustomerMatch } from '@/apps/quick-entry/customers'

export type CustomerLookupStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface CustomerLookupState {
  status: CustomerLookupStatus
  /** The trimmed query this state reflects (so the UI can gate "no matches" on a real search). */
  query: string
  matches: CustomerMatch[]
  error: string | null
  /** True when the endpoint capped the result list — the UI should prompt to refine the search. */
  capped: boolean
}

export const EMPTY_LOOKUP_STATE: CustomerLookupState = { status: 'idle', query: '', matches: [], error: null, capped: false }

const GENERIC_ERROR = 'Could not search customers.'

export interface CustomerLookupOptions {
  /** Called on every state transition. The React hook feeds this into setState. */
  onState: (state: CustomerLookupState) => void
  /** Minimum trimmed length before a request is made (matches the endpoint's own `q.length < 2`). */
  minLength?: number
  debounceMs?: number
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  endpoint?: string
}

export interface CustomerLookupController {
  /** Debounced search. Any call supersedes an in-flight/pending older one. */
  search(rawQuery: string): void
  /** Return to idle and drop results — for selection or an explicit dismiss. */
  clear(): void
  /** Tear down on unmount: cancel debounce, abort in-flight, emit nothing further. */
  dispose(): void
}

export function createCustomerLookup(options: CustomerLookupOptions): CustomerLookupController {
  const minLength = options.minLength ?? 2
  const debounceMs = options.debounceMs ?? 300
  const endpoint = options.endpoint ?? '/api/quick-entry/customers'
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  let version = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let abort: AbortController | null = null
  let disposed = false

  const cancelPending = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (abort) { abort.abort(); abort = null }
  }

  const emit = (state: CustomerLookupState) => { if (!disposed) options.onState(state) }

  const search = (rawQuery: string) => {
    if (disposed) return
    const query = (rawQuery ?? '').trim()
    // Every keystroke bumps the version so any older pending/in-flight work is ignored on return.
    version++
    cancelPending()
    if (query.length < minLength) { emit({ status: 'idle', query, matches: [], error: null, capped: false }); return }

    // Emit loading with EMPTY matches synchronously on the keystroke — stale, still-selectable names
    // must vanish immediately, not linger for the debounce window until a new response arrives.
    emit({ status: 'loading', query, matches: [], error: null, capped: false })
    const mine = version
    timer = setTimeout(() => {
      timer = null
      if (disposed || mine !== version) return
      const ctrl = new AbortController()
      abort = ctrl
      doFetch(`${endpoint}?q=${encodeURIComponent(query)}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (mine !== version) return                                    // superseded while in flight
          if (!res.ok) { emit({ status: 'error', query, matches: [], error: GENERIC_ERROR, capped: false }); return }
          const data = (await res.json().catch(() => null)) as { ok?: boolean; customers?: CustomerMatch[]; capped?: boolean } | null
          if (mine !== version) return
          if (!data || data.ok !== true || !Array.isArray(data.customers)) {
            emit({ status: 'error', query, matches: [], error: GENERIC_ERROR, capped: false }); return
          }
          emit({ status: 'ready', query, matches: data.customers, error: null, capped: data.capped === true })
        })
        .catch((err: unknown) => {
          // An abort (superseded request) is expected — never surface it as an error.
          if (mine !== version || (err as { name?: string } | null)?.name === 'AbortError') return
          emit({ status: 'error', query, matches: [], error: GENERIC_ERROR, capped: false })
        })
        .finally(() => { if (abort === ctrl) abort = null })
    }, debounceMs)
  }

  const clear = () => {
    if (disposed) return
    version++
    cancelPending()
    emit({ status: 'idle', query: '', matches: [], error: null, capped: false })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    version++
    cancelPending()
  }

  return { search, clear, dispose }
}
