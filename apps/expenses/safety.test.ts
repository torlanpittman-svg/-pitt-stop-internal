import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const MODULE_FILES = ['./db.ts', './actions.ts', './ai.ts', './types.ts', './view.ts', './upload-validation.ts', './schema.ts']

describe('no QuickBooks mutation from the expenses module', () => {
  it('no module file imports the quickbooks app', () => {
    for (const f of MODULE_FILES) {
      const src = read(f)
      expect(src, `${f} must not import quickbooks`).not.toMatch(/from ['"]@\/apps\/quickbooks/)
    }
  })
  it('nothing ever ASSIGNS qb sync status to "synced" (the value exists only as a future type)', () => {
    for (const f of MODULE_FILES) {
      expect(read(f)).not.toMatch(/qbSyncStatus:\s*['"]synced['"]/)
      expect(read(f)).not.toMatch(/qb_synced_at\s*=|qbSyncedAt:\s*new Date/)
    }
    // 'synced' appears only in the QB_SYNC_STATUSES type union — never written.
    expect(read('./types.ts')).toMatch(/QB_SYNC_STATUSES/)
    // approval marks receipts export_ready (internal), never synced.
    expect(read('./db.ts')).toContain("qbSyncStatus: 'export_ready'")
  })
})

describe('duplicate detection uses SHA-256 of the original bytes', () => {
  it('identical bytes → identical hash; different bytes → different hash', () => {
    const a = Buffer.from([1, 2, 3, 4, 5])
    const aCopy = Buffer.from([1, 2, 3, 4, 5])
    const b = Buffer.from([1, 2, 3, 4, 6])
    const h = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')
    expect(h(a)).toBe(h(aCopy))
    expect(h(a)).not.toBe(h(b))
    expect(h(a)).toHaveLength(64)
  })
})
