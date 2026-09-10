import { describe, it, expect } from 'vitest'
import { checkConfigReadiness, bankForCategory, type CheckConfig } from './config'
import { categoryEntity } from './types'
import { DEFAULT_LAYOUT } from './layout'

function cfg(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    enabled: true,
    banks: {
      operating: { key: 'operating', qboAccountId: '31', label: 'Operating *2649' },
      auto_sales: { key: 'auto_sales', qboAccountId: '', label: 'Auto Sales *5600' },
    },
    categoryAccounts: {},
    layout: DEFAULT_LAYOUT,
    ...overrides,
  }
}

describe('operating vs Auto Sales separation', () => {
  it('customer_job / shop_general / equipment / owner_personal / other → operating entity', () => {
    for (const k of ['customer_job', 'shop_general', 'equipment', 'owner_personal', 'other']) expect(categoryEntity(k)).toBe('operating')
  })
  it('auto_sales → auto_sales entity (isolated)', () => {
    expect(categoryEntity('auto_sales')).toBe('auto_sales')
  })
  it('bankForCategory routes auto_sales to the auto_sales bank and everything else to operating', () => {
    const c = cfg()
    expect(bankForCategory(c, 'shop_general').key).toBe('operating')
    expect(bankForCategory(c, 'auto_sales').key).toBe('auto_sales')
  })
})

describe('checkConfigReadiness — fail-closed until configured', () => {
  it('not ready when disabled', () => {
    expect(checkConfigReadiness(cfg({ enabled: false })).ready).toBe(false)
  })
  it('not ready when operating bank missing', () => {
    const c = cfg({ banks: { operating: { key: 'operating', qboAccountId: '', label: 'x' }, auto_sales: { key: 'auto_sales', qboAccountId: '', label: 'y' } } })
    expect(checkConfigReadiness(c).ready).toBe(false)
  })
  it('ready once enabled + operating bank set', () => {
    expect(checkConfigReadiness(cfg()).ready).toBe(true)
  })
  it('reports every unmapped category account', () => {
    const r = checkConfigReadiness(cfg({ categoryAccounts: { shop_general: '7' } }))
    expect(r.missingCategoryAccounts).toContain('equipment')
    expect(r.missingCategoryAccounts).not.toContain('shop_general')
  })
})
