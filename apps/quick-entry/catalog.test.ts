import { describe, it, expect } from 'vitest'
import { CATALOG_ITEMS, TECH_INSTRUCTIONS, LEGACY_TERMINOLOGY } from './seed-data'
import { validateCatalogSeed, resolveStartPriceCents, pickTierPrice, partitionCatalog, startingPriceLabel, isDealerPackage } from './catalog'

const bySlug = (s: string) => CATALOG_ITEMS.find((i) => i.slug === s)!

describe('catalog seed integrity', () => {
  it('has no structural issues', () => {
    expect(validateCatalogSeed(CATALOG_ITEMS)).toEqual([])
  })
  it('slugs are unique', () => {
    const slugs = CATALOG_ITEMS.map((i) => i.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
  it('every technician instruction is non-billable and slugged', () => {
    expect(TECH_INSTRUCTIONS.length).toBeGreaterThanOrEqual(25)
    for (const t of TECH_INSTRUCTIONS) expect(t.slug).toMatch(/^ti_[a-z0-9_]+$/)
  })
})

describe('price resolution', () => {
  it('resolves tiered Complete Detail by vehicle size', () => {
    const cd = bySlug('complete_detail')
    expect(resolveStartPriceCents(cd, cd.tiers!, 'coupe_small_sedan')).toBe(35000)
    expect(resolveStartPriceCents(cd, cd.tiers!, 'standard_sedan')).toBe(40000)
    expect(resolveStartPriceCents(cd, cd.tiers!, 'truck')).toBe(45000)
    expect(resolveStartPriceCents(cd, cd.tiers!, 'large_3row_suv')).toBe(50000)
  })
  it('resolves Interior Detail by size + condition (Heavy = $500 floor)', () => {
    const id = bySlug('interior_detail')
    expect(pickTierPrice(id.tiers!, 'sedan', 'normal')).toBe(30000)
    expect(pickTierPrice(id.tiers!, 'sedan', 'heavy')).toBe(50000)
    expect(pickTierPrice(id.tiers!, 'truck_suv', 'normal')).toBe(40000)
    expect(pickTierPrice(id.tiers!, 'truck_suv', 'heavy')).toBe(50000)
  })
  it('resolves flat-priced items from the default', () => {
    expect(resolveStartPriceCents(bySlug('mini_detail'), [])).toBe(15000)
    expect(resolveStartPriceCents(bySlug('paint_correction_1step'), [])).toBe(65000)
  })
})

describe('admin view: retail/dealer separation + tier rendering', () => {
  const parts = partitionCatalog(CATALOG_ITEMS)
  it('separates retail packages, dealer packages, and add-ons', () => {
    expect(parts.retailPackages).toHaveLength(9)   // incl. Exterior Wash
    expect(parts.dealerPackages).toHaveLength(3)
    expect(parts.quickAddons).toHaveLength(3)
    expect(parts.customAddons).toHaveLength(4)
    expect(parts.retailPackages.length + parts.dealerPackages.length + parts.quickAddons.length + parts.customAddons.length).toBe(CATALOG_ITEMS.length)
  })
  it('dealer packages are exactly the dealer_rules ones; no dealer item lands in retail', () => {
    expect(parts.dealerPackages.every((i) => isDealerPackage(i))).toBe(true)
    expect(parts.retailPackages.some((i) => isDealerPackage(i))).toBe(false)
  })
  it('renders tiered price as "from $min" and flat price directly', () => {
    const cd = CATALOG_ITEMS.find((i) => i.slug === 'complete_detail')!
    expect(startingPriceLabel(cd, cd.tiers!)).toBe('from $350.00')
    const mini = CATALOG_ITEMS.find((i) => i.slug === 'mini_detail')!
    expect(startingPriceLabel(mini, [])).toBe('$150.00')
    const wax = CATALOG_ITEMS.find((i) => i.slug === 'exterior_wax')!
    expect(startingPriceLabel(wax, [])).toBe('—') // review item, no price
  })
})

describe('owner decisions are encoded', () => {
  it('Ceramic Coating is split 1yr/3yr, each needing a NEW QB item with sync OFF', () => {
    const one = bySlug('ceramic_coating_1yr'); const three = bySlug('ceramic_coating_3yr')
    expect(one.defaultPriceCents).toBe(80000)
    expect(three.defaultPriceCents).toBe(200000)
    for (const c of [one, three]) {
      expect(c.qbItemStatus).toBe('new_create_at_golive')
      expect(c.qbSyncEnabled).toBe(false)
      expect(c.qbItemRef).toBeNull()
    }
  })
  it('Exterior Wash is an active $100 retail service, mapped to QB 6 but sync-off pending review', () => {
    const w = bySlug('exterior_wash')
    expect(w.kind).toBe('package'); expect(w.active).toBe(true); expect(w.quickEntry).toBe(true)
    expect(w.defaultPriceCents).toBe(10000)
    expect(w.qbItemRef).toBe('6'); expect(w.qbItemStatus).toBe('mapping_review'); expect(w.qbSyncEnabled).toBe(false)
  })
  it('dealer packages use configured rates ($200/$125/$75); $190 is retired', () => {
    expect(bySlug('dealer_complete_detail_standard').defaultPriceCents).toBe(20000)
    expect(bySlug('dealer_complete_detail_new_vehicle').defaultPriceCents).toBe(12500)
    expect(bySlug('dealer_complete_detail_touchup').defaultPriceCents).toBe(7500)
    expect(CATALOG_ITEMS.some((i) => i.defaultPriceCents === 19000)).toBe(false)
  })
  it('every price is editable; nothing carries an approval gate in V1', () => {
    // seed items never set priceEditable=false
    expect(CATALOG_ITEMS.some((i) => (i as { priceEditable?: boolean }).priceEditable === false)).toBe(false)
  })
  it('aliases exist but are not yet AI-approved (owner approves later)', () => {
    // seed-data does not pre-approve aliases for AI
    expect(CATALOG_ITEMS.every((i) => !(i as { approvedForAi?: boolean }).approvedForAi)).toBe(true)
  })
})

describe('legacy C/P terminology handling', () => {
  it('C/P (Compound & Polish) terms are flagged legacy, kept only as aliases', () => {
    expect(LEGACY_TERMINOLOGY).toEqual(expect.arrayContaining(['C/P Complete Detail', 'Compound/Polish', 'Compound/Sealant']))
    // and each legacy term actually appears as an alias somewhere in the catalog
    const allAliases = CATALOG_ITEMS.flatMap((i) => i.aliases ?? [])
    for (const t of LEGACY_TERMINOLOGY) expect(allAliases).toContain(t)
  })
  it('no C/P terminology is attached to Interior Detail', () => {
    const interior = CATALOG_ITEMS.find((i) => i.slug === 'interior_detail')!
    expect((interior.aliases ?? []).some((a) => /c\/p/i.test(a))).toBe(false)
  })
  it('interior detail and complete detail are distinct services (C/P Detail is not Interior)', () => {
    expect(CATALOG_ITEMS.find((i) => i.slug === 'interior_detail')).toBeDefined()
    expect(CATALOG_ITEMS.find((i) => i.slug === 'complete_detail')).toBeDefined()
    // legacy C/P Complete Detail maps to complete_detail, never interior_detail
    const cpHost = CATALOG_ITEMS.find((i) => (i.aliases ?? []).includes('C/P Complete Detail'))!
    expect(cpHost.slug).toBe('complete_detail')
  })
})
