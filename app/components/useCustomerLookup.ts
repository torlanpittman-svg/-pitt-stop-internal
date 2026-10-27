'use client'

/**
 * React wrapper around the framework-agnostic customer-lookup controller
 * (`app/lib/customer-lookup.ts`). Owns a single controller for the component's lifetime, mirrors
 * its state into React state, and disposes it on unmount (cancels the debounce, aborts any
 * in-flight request, and stops emitting). The controller holds all the staleness/abort logic;
 * this hook is intentionally thin so both intake flows get identical behavior.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createCustomerLookup,
  EMPTY_LOOKUP_STATE,
  type CustomerLookupController,
  type CustomerLookupState,
} from '@/app/lib/customer-lookup'

export interface UseCustomerLookup extends CustomerLookupState {
  /** Debounced search; pass the raw name/phone/email text as typed. */
  search: (query: string) => void
  /** Drop results and return to idle — call on selection or dismiss. */
  clear: () => void
}

export function useCustomerLookup(opts?: { minLength?: number; debounceMs?: number }): UseCustomerLookup {
  const [state, setState] = useState<CustomerLookupState>(EMPTY_LOOKUP_STATE)
  const ref = useRef<CustomerLookupController | null>(null)
  const minLength = opts?.minLength
  const debounceMs = opts?.debounceMs

  // Create the controller in effect SETUP (not render) and tear it down + null the ref in cleanup.
  // React StrictMode runs setup→cleanup→setup; a render-time singleton would be disposed on the first
  // cleanup and never recreated, leaving a dead controller. This pairing always hands back a live one.
  useEffect(() => {
    const controller = createCustomerLookup({ onState: setState, minLength, debounceMs })
    ref.current = controller
    return () => { controller.dispose(); if (ref.current === controller) ref.current = null }
  }, [minLength, debounceMs])

  // Optional-chained so a stray call before setup / after cleanup is a harmless no-op, never a crash.
  const search = useCallback((q: string) => ref.current?.search(q), [])
  const clear = useCallback(() => ref.current?.clear(), [])
  return { ...state, search, clear }
}
