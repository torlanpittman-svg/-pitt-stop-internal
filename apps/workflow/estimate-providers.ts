/**
 * Provider-ready interfaces for FUTURE labor-guide, parts, and collision-estimating
 * integrations. V1 ships with NO providers configured → manual entry only. Results
 * map onto job_line_items' provider fields (provider, provider_ref, part_number,
 * brand, supplier). Mirrors the proven plate-lookup adapter pattern.
 */
import type { LineType, TaxCategory } from './estimate'

export interface VehicleRef { vin?: string | null; year?: string | null; make?: string | null; model?: string | null }

export interface LaborOp {
  name: string
  hours: number
  ratePerHourCents?: number
  provider: string
  providerRef?: string
}
export interface PartResult {
  name: string
  brand?: string
  partNumber?: string
  supplier?: string
  costCents?: number
  priceCents?: number
  provider: string
  providerRef?: string
}
export interface EstimateDraftLine {
  type: LineType
  name: string
  qty: number
  costCents?: number
  priceCents?: number
  taxable?: boolean
  taxCategory?: TaxCategory
  provider?: string
  providerRef?: string
}

export interface LaborGuideProvider { readonly name: string; lookupLabor(v: VehicleRef, operation: string): Promise<LaborOp[]> }
export interface PartsProvider { readonly name: string; searchParts(v: VehicleRef, query: string): Promise<PartResult[]> }
export interface CollisionEstimateProvider { readonly name: string; importEstimate(ref: string): Promise<EstimateDraftLine[]> }

// ── Registries — return null in V1 (manual entry only) ───────────────────────
export function getLaborGuideProvider(): LaborGuideProvider | null {
  // Future: switch on process.env.LABOR_GUIDE_PROVIDER (motor/mitchell/…)
  return null
}
export function getPartsProvider(): PartsProvider | null {
  // Future: switch on process.env.PARTS_PROVIDER (partstech/…)
  return null
}
export function getCollisionEstimateProvider(): CollisionEstimateProvider | null {
  return null
}

/** Whether any estimate provider is configured (drives "Look up" affordances). */
export function anyEstimateProviderConfigured(): boolean {
  return getLaborGuideProvider() !== null || getPartsProvider() !== null || getCollisionEstimateProvider() !== null
}
