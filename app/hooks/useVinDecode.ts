'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * Shared client VIN-decode helper — one place so every vehicle-edit surface behaves the
 * same. Reuses the existing decoder via POST /api/workflow/vin (NHTSA). Does NOT create a
 * second VIN system. Callers own the fill/confirm UX; this only validates + decodes.
 */
export interface VinDecodeResult {
  ok: boolean          // true = valid VIN that decoded to at least make/year
  valid: boolean       // false = not a real VIN (bad check digit / length)
  vin: string
  year: string | null
  make: string | null
  model: string | null
  error?: string
}

export type VinDecodeStatus = 'idle' | 'decoding' | 'ok' | 'invalid' | 'failed'

export function useVinDecode() {
  const [status, setStatus] = useState<VinDecodeStatus>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastVin = useRef<string>('')

  /** Sanitize a typed VIN: uppercase, strip I/O/Q + non-VIN chars, cap 17. */
  const sanitize = useCallback((raw: string) => raw.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17), [])

  const decode = useCallback(async (raw: string): Promise<VinDecodeResult> => {
    const vin = raw.trim().toUpperCase()
    if (vin.length !== 17) return { ok: false, valid: false, vin, year: null, make: null, model: null, error: 'VIN must be 17 characters' }
    setStatus('decoding')
    try {
      const res = await fetch('/api/workflow/vin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin }) })
      if (res.status === 422) { const d = await res.json().catch(() => ({})); setStatus('invalid'); return { ok: false, valid: false, vin, year: null, make: null, model: null, error: d.error ?? 'Invalid VIN' } }
      if (!res.ok) { setStatus('failed'); return { ok: false, valid: true, vin, year: null, make: null, model: null, error: 'VIN lookup unavailable' } }
      const d = await res.json()
      const decoded = !!(d.year || d.make)
      setStatus(decoded ? 'ok' : 'failed')
      return { ok: decoded, valid: true, vin: d.vin ?? vin, year: d.year ?? null, make: d.make ?? null, model: d.model ?? null, error: decoded ? undefined : 'Could not decode this VIN' }
    } catch { setStatus('failed'); return { ok: false, valid: true, vin, year: null, make: null, model: null, error: 'Network error' } }
  }, [])

  /** Debounced auto-decode as the user types/corrects the VIN (no button). Fires once the
   *  VIN reaches 17 chars and differs from the last decoded value. */
  const decodeDebounced = useCallback((raw: string, cb: (r: VinDecodeResult) => void, ms = 550) => {
    const vin = raw.trim().toUpperCase()
    if (timer.current) clearTimeout(timer.current)
    if (vin.length !== 17) { setStatus('idle'); return }
    if (vin === lastVin.current) return
    timer.current = setTimeout(async () => { lastVin.current = vin; cb(await decode(vin)) }, ms)
  }, [decode])

  return { status, setStatus, decode, decodeDebounced, sanitize }
}
