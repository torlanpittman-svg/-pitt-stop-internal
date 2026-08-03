/**
 * Quick Entry catalog V1 seed — the single source of truth for the seed insert
 * AND the tests. Prices in cents. Reflects the approved owner decisions:
 *  - Ceramic Coating split into 1-Year / 3-Year, each needing a NEW QB item
 *    (qb sync disabled until created + mapped).
 *  - Exterior Wash is an active retail service at $100 (mapped to existing QB
 *    item 6 but flagged for mapping review; sync disabled until confirmed).
 *  - Every price editable + audited; NO manager approval in V1.
 *  - Dealer prices come from the Dealer Check-In rules engine, not AI.
 *  - Aliases are seeded but NOT approved_for_ai (owner approves later).
 */

export interface SeedTier { size: string; condition: string; startPriceCents: number; sortOrder: number }
export interface SeedItem {
  slug: string; name: string; kind: 'package' | 'addon' | 'placeholder'
  quickEntry: boolean; hasSize?: boolean; hasCondition?: boolean
  defaultPriceCents: number | null; sortOrder: number; source: string
  requiresNotes?: boolean; requiresPhoto?: boolean
  qbItemRef: string | null; qbItemStatus: 'existing' | 'new_create_at_golive' | 'mapping_review'
  qbSyncEnabled: boolean; reviewFlag?: boolean; active?: boolean; notes?: string
  tiers?: SeedTier[]; aliases?: string[]
}
export interface SeedTechInstruction { slug: string; label: string; group: string; sortOrder: number }

export const CATALOG_ITEMS: SeedItem[] = [
  // ── Retail packages ───────────────────────────────────────────────────────
  { slug: 'complete_detail', name: 'Complete Detail', kind: 'package', quickEntry: true, hasSize: true,
    defaultPriceCents: null, sortOrder: 10, source: 'seed_v1', qbItemRef: '3', qbItemStatus: 'existing', qbSyncEnabled: true,
    aliases: ['Complete Detail', 'C/P Complete Detail', 'Complete Detail/ Sanitize'],
    tiers: [
      { size: 'coupe_small_sedan', condition: '', startPriceCents: 35000, sortOrder: 1 },
      { size: 'standard_sedan',    condition: '', startPriceCents: 40000, sortOrder: 2 },
      { size: 'truck',             condition: '', startPriceCents: 45000, sortOrder: 3 },
      { size: 'large_3row_suv',    condition: '', startPriceCents: 50000, sortOrder: 4 },
    ] },
  { slug: 'interior_detail', name: 'Interior Detail', kind: 'package', quickEntry: true, hasSize: true, hasCondition: true,
    defaultPriceCents: null, sortOrder: 20, source: 'seed_v1', qbItemRef: '8', qbItemStatus: 'existing', qbSyncEnabled: true,
    aliases: ['Interior Detail'],
    tiers: [
      { size: 'sedan',     condition: 'normal', startPriceCents: 30000, sortOrder: 1 },
      { size: 'sedan',     condition: 'heavy',  startPriceCents: 50000, sortOrder: 2 },
      { size: 'truck_suv', condition: 'normal', startPriceCents: 40000, sortOrder: 3 },
      { size: 'truck_suv', condition: 'heavy',  startPriceCents: 50000, sortOrder: 4 },
    ] },
  { slug: 'mini_detail', name: 'Mini Detail', kind: 'package', quickEntry: true, defaultPriceCents: 15000, sortOrder: 30,
    source: 'seed_v1', qbItemRef: '2', qbItemStatus: 'existing', qbSyncEnabled: true, aliases: ['Mini Detail'],
    notes: 'historical low end ~$100' },
  { slug: 'paint_correction_1step', name: 'Paint Correction / Polish (1-step)', kind: 'package', quickEntry: true,
    defaultPriceCents: 65000, sortOrder: 40, source: 'seed_v1', requiresPhoto: true, qbItemRef: '58', qbItemStatus: 'existing',
    qbSyncEnabled: true, aliases: ['Paint correction', 'Compound/Polish', 'Compound/Sealant', 'Clay/Seal', 'Polish'],
    notes: 'larger/heavier vehicles $750-900+ (edit up)' },
  { slug: 'ceramic_coating_1yr', name: 'Ceramic Coating — 1-Year', kind: 'package', quickEntry: true, defaultPriceCents: 80000,
    sortOrder: 50, source: 'seed_v1', requiresPhoto: true, qbItemRef: null, qbItemStatus: 'new_create_at_golive',
    qbSyncEnabled: false, aliases: ['Ceramic Coating'], notes: 'needs NEW QB item; legacy generic item 70 not reused' },
  { slug: 'ceramic_coating_3yr', name: 'Ceramic Coating — 3-Year', kind: 'package', quickEntry: true, defaultPriceCents: 200000,
    sortOrder: 51, source: 'seed_v1', requiresPhoto: true, qbItemRef: null, qbItemStatus: 'new_create_at_golive',
    qbSyncEnabled: false, aliases: ['Ceramic Coating'], notes: 'needs NEW QB item; legacy generic item 70 not reused' },
  { slug: 'headliner_cleaning', name: 'Headliner Cleaning', kind: 'package', quickEntry: true, defaultPriceCents: 25000,
    sortOrder: 60, source: 'seed_v1', qbItemRef: '28', qbItemStatus: 'existing', qbSyncEnabled: true, aliases: ['Clean Headliner'] },
  { slug: 'headliner_replacement', name: 'Headliner Replacement', kind: 'package', quickEntry: true, defaultPriceCents: 60000,
    sortOrder: 61, source: 'seed_v1', requiresPhoto: true, qbItemRef: '84', qbItemStatus: 'existing', qbSyncEnabled: true, aliases: ['Headliner'] },
  { slug: 'exterior_wash', name: 'Exterior Wash', kind: 'package', quickEntry: true, defaultPriceCents: 10000, sortOrder: 70,
    source: 'owner', qbItemRef: '6', qbItemStatus: 'mapping_review', qbSyncEnabled: false, active: true,
    aliases: ['Exterior Wash'], notes: 'owner-set $100; maps to existing QB item 6 pending mapping review; historical pricing NOT used' },

  // ── Dealer packages (prices from the Dealer Check-In rules engine) ─────────
  { slug: 'dealer_complete_detail_standard', name: 'Dealer Complete Detail — Standard', kind: 'package', quickEntry: true,
    defaultPriceCents: 20000, sortOrder: 100, source: 'dealer_rules', qbItemRef: '3', qbItemStatus: 'existing', qbSyncEnabled: true,
    aliases: ['Complete Detail'], notes: '$190 retired (historical only)' },
  { slug: 'dealer_complete_detail_new_vehicle', name: 'Dealer Complete Detail — New Vehicle', kind: 'package', quickEntry: true,
    defaultPriceCents: 12500, sortOrder: 101, source: 'dealer_rules', qbItemRef: '3', qbItemStatus: 'existing', qbSyncEnabled: true,
    aliases: ['Complete Detail'], notes: 'existing new-vehicle dealer rule' },
  { slug: 'dealer_complete_detail_touchup', name: 'Dealer Complete Detail — Touch-up/Minimal', kind: 'package', quickEntry: true,
    defaultPriceCents: 7500, sortOrder: 102, source: 'dealer_rules', qbItemRef: '3', qbItemStatus: 'existing', qbSyncEnabled: true,
    aliases: ['Complete Detail'], notes: 'explicit selection only' },

  // ── Add-ons (Quick Entry) ─────────────────────────────────────────────────
  { slug: 'odor_ozone', name: 'Odor / Ozone Treatment', kind: 'addon', quickEntry: true, defaultPriceCents: 30000, sortOrder: 200,
    source: 'seed_v1', qbItemRef: '24', qbItemStatus: 'existing', qbSyncEnabled: true,
    aliases: ['Ozone', 'Ozone Treatment', 'Odor Treatment'], notes: 'consolidates QB items 24/25/68' },
  { slug: 'headlight_restoration', name: 'Headlight Restoration', kind: 'addon', quickEntry: true, defaultPriceCents: 15000,
    sortOrder: 210, source: 'seed_v1', qbItemRef: '4', qbItemStatus: 'existing', qbSyncEnabled: true, aliases: ['Headlights'] },
  { slug: 'engine_bay_clean', name: 'Engine Bay / Motor Clean', kind: 'addon', quickEntry: true, defaultPriceCents: 7500,
    sortOrder: 220, source: 'seed_v1', qbItemRef: '37', qbItemStatus: 'existing', qbSyncEnabled: true, aliases: ['Engine bay', 'Clean Motor'] },

  // ── Add-ons (Add Custom Service only — not quick buttons) ──────────────────
  { slug: 'clay_bar', name: 'Clay Bar', kind: 'addon', quickEntry: false, defaultPriceCents: 20000, sortOrder: 300,
    source: 'seed_v1', qbItemRef: '67', qbItemStatus: 'existing', qbSyncEnabled: true, aliases: ['Clay bar'], notes: 'low freq; usually paint-correction prep' },
  { slug: 'leather_conditioner', name: 'Leather Conditioner', kind: 'addon', quickEntry: false, defaultPriceCents: 5000,
    sortOrder: 310, source: 'seed_v1', qbItemRef: '66', qbItemStatus: 'existing', qbSyncEnabled: true, aliases: ['Leather Conditioner'] },
  { slug: 'floor_mats', name: 'Floor Mats (OEM/replacement)', kind: 'addon', quickEntry: false, defaultPriceCents: null, sortOrder: 320,
    source: 'seed_v1', reviewFlag: true, qbItemRef: '42', qbItemStatus: 'mapping_review', qbSyncEnabled: false, aliases: ['Mats', 'Floor mats'], notes: 'history $100-1050 — review' },
  { slug: 'exterior_wax', name: 'Exterior Wax', kind: 'addon', quickEntry: false, defaultPriceCents: null, sortOrder: 330,
    source: 'seed_v1', reviewFlag: true, qbItemRef: '69', qbItemStatus: 'mapping_review', qbSyncEnabled: false, aliases: ['Exterior Wax'], notes: 'low n — review' },
]

export const TECH_INSTRUCTIONS: SeedTechInstruction[] = [
  ...['Pet hair', 'Excessive trash', 'Heavy stains', 'Smoke/odor present', 'Mold/mildew', 'Heavy sand/dirt', 'Overspray present', 'Swirls/scratches', 'Water spots', 'Sap/tar', 'Biohazard']
    .map((label, i) => ({ label, group: 'intake_condition_flags', sortOrder: i + 1 })),
  ...['Check cabin filter', 'Check headliner', 'Inspect odor source', 'Test-polish scratch (test spot)', 'Check for existing coating', 'Check paint/clear condition']
    .map((label, i) => ({ label, group: 'pre_work_checks', sortOrder: i + 1 })),
  ...['Remove stain', 'Wet-sand (test first)', 'Two-step correction needed', 'Ozone after cleaning', 'Protect trim/emblems', 'Avoid specific area']
    .map((label, i) => ({ label, group: 'process_instructions', sortOrder: i + 1 })),
  ...['Call customer before additional work', 'Get approval for add-ons', 'Send before/after photos', 'Confirm pickup time']
    .map((label, i) => ({ label, group: 'customer_communication', sortOrder: i + 1 })),
  { label: 'Other technician instructions', group: 'free_text', sortOrder: 1 },
].map((t) => ({ ...t, slug: 'ti_' + t.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') }))
