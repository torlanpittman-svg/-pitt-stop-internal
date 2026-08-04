/**
 * License Plate → VIN lookup — provider-agnostic.
 *
 * A `PlateProvider` turns (plate, state) into a VIN + best-effort vehicle fields.
 * Auto.dev is the first provider; PlateToVIN/others can be added behind the same
 * interface without touching the Quick Entry route or UI. The returned VIN is
 * always re-decoded/validated through NHTSA vPIC by the caller — the provider's
 * make/model/trim are supplementary only.
 *
 * Credentials are read from server-only env vars and never leave the server.
 * The feature is gated: disabled unless PLATE_LOOKUP_ENABLED=true AND a provider
 * key is configured.
 */

export interface PlateProviderResult {
  vin:       string | null
  year?:     string | null
  make?:     string | null
  model?:    string | null
  trim?:     string | null
  status:    string          // e.g. 'http_200', 'http_404', 'error' — for audit, no secrets
  requestId: string | null
}

export interface PlateProvider {
  readonly name: string
  lookup(plate: string, state: string): Promise<PlateProviderResult>
}

// ── Input normalization ──────────────────────────────────────────────────────

/** Uppercase, strip spaces/punctuation (keeps A–Z, 0–9). */
export function normalizePlate(raw: string): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
  'NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY',
] as const

export function isValidState(s: string): boolean {
  return US_STATES.includes((s ?? '').toUpperCase() as (typeof US_STATES)[number])
}

// ── Auto.dev provider ────────────────────────────────────────────────────────
// GET https://api.auto.dev/plate/{STATE}/{PLATE}  Authorization: Bearer <key>

class AutoDevProvider implements PlateProvider {
  readonly name = 'auto_dev'
  constructor(private readonly apiKey: string) {}

  async lookup(plate: string, state: string): Promise<PlateProviderResult> {
    const url = `https://api.auto.dev/plate/${encodeURIComponent(state)}/${encodeURIComponent(plate)}`
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(12_000),
      })
    } catch {
      return { vin: null, status: 'error', requestId: null }
    }
    const requestId = res.headers.get('x-request-id') ?? res.headers.get('x-amzn-requestid')
    if (!res.ok) return { vin: null, status: `http_${res.status}`, requestId } // 404 = plate not found
    const d = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return {
      vin:   typeof d.vin === 'string' && d.vin ? d.vin : null,
      year:  d.year != null ? String(d.year) : null,
      make:  typeof d.make === 'string' ? d.make : null,
      model: typeof d.model === 'string' ? d.model : null,
      trim:  typeof d.trim === 'string' ? d.trim : null,
      status: `http_${res.status}`,
      requestId,
    }
  }
}

// ── PlateToVIN provider ──────────────────────────────────────────────────────
// POST https://platetovin.com/api/convert  header Authorization: <API key> (raw)
// body { state, plate } → { success, vin: { vin, year, make, model, trim, style, ... } }

class PlateToVinProvider implements PlateProvider {
  readonly name = 'platetovin'
  constructor(private readonly apiKey: string) {}

  async lookup(plate: string, state: string): Promise<PlateProviderResult> {
    let res: Response
    try {
      res = await fetch('https://platetovin.com/api/convert', {
        method: 'POST',
        headers: { Authorization: this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ state, plate }),
        signal: AbortSignal.timeout(12_000),
      })
    } catch {
      return { vin: null, status: 'error', requestId: null }
    }
    const requestId = res.headers.get('x-request-id')
    if (!res.ok) return { vin: null, status: `http_${res.status}`, requestId }
    const d = (await res.json().catch(() => ({}))) as { success?: boolean; vin?: Record<string, unknown> }
    const v = d.vin ?? {}
    const vin = typeof v.vin === 'string' && v.vin ? v.vin : null
    if (!d.success || !vin) return { vin: null, status: `http_${res.status}`, requestId }
    return {
      vin,
      year:  v.year != null ? String(v.year) : null,
      make:  typeof v.make === 'string' ? v.make : null,
      model: typeof v.model === 'string' ? v.model : null,
      trim:  typeof v.trim === 'string' ? v.trim : null,
      status: `http_${res.status}`,
      requestId,
    }
  }
}

// ── Registry + feature flag ──────────────────────────────────────────────────

/** The configured provider, or null if its key is not present. Default: platetovin. */
export function getPlateProvider(): PlateProvider | null {
  const which = (process.env.PLATE_LOOKUP_PROVIDER || 'platetovin').toLowerCase()
  if (which === 'platetovin') {
    const key = process.env.PLATETOVIN_API_KEY
    return key ? new PlateToVinProvider(key) : null
  }
  if (which === 'auto_dev') {
    // Kept as a disabled fallback provider (Auto.dev plate-to-VIN needs a paid plan).
    const key = process.env.AUTODEV_API_KEY
    return key ? new AutoDevProvider(key) : null
  }
  return null
}

/** Feature flag: on only when explicitly enabled AND a provider key is configured. */
export function isPlateLookupEnabled(): boolean {
  return process.env.PLATE_LOOKUP_ENABLED === 'true' && getPlateProvider() !== null
}
