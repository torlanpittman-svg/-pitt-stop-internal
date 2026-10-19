import { describe, it, expect, afterEach, vi } from 'vitest'
import { isWriteSql, isKnownProdUrl, prodWriteGuardActive, classifyDbTarget, queryTextFrom, guardNeonClient } from './prod-db-guard'

describe('isWriteSql', () => {
  it('treats reads as reads', () => {
    for (const s of [
      'select * from service_orders',
      '  SELECT 1',
      '\n-- comment\nselect id from vehicles',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN SELECT 1',
      'SHOW server_version',
      'SET search_path = public',
      'BEGIN',
      'COMMIT',
    ]) expect(isWriteSql(s), s).toBe(false)
  })

  it('treats mutations and DDL as writes', () => {
    for (const s of [
      "insert into service_orders (id) values ('x')",
      "UPDATE service_orders SET status='delivered' WHERE id='x'",
      'delete from job_parts where id = $1',
      'merge into t using s on (t.id=s.id) when matched then update set a=1',
      'create table t (id int)',
      'ALTER TABLE t ADD COLUMN c int',
      'drop table t',
      'truncate t',
      '/* c */  update t set a=1',
      'WITH moved AS (DELETE FROM t RETURNING *) INSERT INTO log SELECT * FROM moved',
    ]) expect(isWriteSql(s), s).toBe(true)
  })
})

describe('isKnownProdUrl', () => {
  it('matches the known prod endpoint marker and nothing else', () => {
    expect(isKnownProdUrl('postgresql://u:p@ep-morning-base-adq5h6rq-pooler.c-2.aws.neon.tech/neondb')).toBe(true)
    expect(isKnownProdUrl('postgresql://u:p@ep-dev-branch-xyz.c-2.aws.neon.tech/neondb')).toBe(false)
    expect(isKnownProdUrl(undefined)).toBe(false)
    expect(isKnownProdUrl(null)).toBe(false)
  })
})

describe('prodWriteGuardActive', () => {
  const prod = 'postgresql://u:p@ep-morning-base-adq5h6rq-pooler.c-2.aws.neon.tech/neondb'
  const dev = 'postgresql://u:p@ep-dev-branch-xyz.c-2.aws.neon.tech/neondb'
  it('is active for a LOCAL process pointed at prod', () => {
    expect(prodWriteGuardActive({ DATABASE_URL: prod })).toBe(true)
  })
  it('is active (fail-closed) for an UNDECLARED, unrecognized endpoint', () => {
    // The bug that caused this guard rewrite: a non-prod-marker endpoint with no DATABASE_ENV was
    // silently treated as writable. It must now be BLOCKED until positively declared.
    expect(prodWriteGuardActive({ DATABASE_URL: dev })).toBe(true)
  })
  it('is active for a LOCAL process even when DATABASE_ENV says production on a dev-looking host', () => {
    expect(prodWriteGuardActive({ DATABASE_URL: dev, DATABASE_ENV: 'production' })).toBe(true)
  })
  it('is inert on Vercel (deployed)', () => {
    expect(prodWriteGuardActive({ DATABASE_URL: prod, VERCEL: '1' })).toBe(false)
  })
  it('is inert for a POSITIVELY declared dev branch', () => {
    expect(prodWriteGuardActive({ DATABASE_URL: dev, DATABASE_ENV: 'development' })).toBe(false)
  })
  it('still BLOCKS a declared-dev env that actually points at the known prod host', () => {
    // Belt-and-suspenders: the hard-coded prod marker overrides a (wrong) dev declaration.
    expect(prodWriteGuardActive({ DATABASE_URL: prod, DATABASE_ENV: 'development' })).toBe(true)
  })
  it('is inert with an explicit override', () => {
    expect(prodWriteGuardActive({ DATABASE_URL: prod, ALLOW_PROD_DB_WRITES: '1' })).toBe(false)
  })
})

describe('classifyDbTarget', () => {
  it('labels the known prod host as production regardless of declaration', () => {
    expect(classifyDbTarget({ DATABASE_URL: 'postgresql://u:p@ep-morning-base-adq5h6rq.neon.tech/db' })).toBe('production')
  })
  it('labels an undeclared unknown host as unknown (not non-prod)', () => {
    expect(classifyDbTarget({ DATABASE_URL: 'postgresql://u:p@ep-bold-surf-adhsy8f5.neon.tech/db' })).toBe('unknown')
  })
  it('labels a declared dev host as declared-nonprod', () => {
    expect(classifyDbTarget({ DATABASE_URL: 'postgresql://u:p@ep-bold-surf-adhsy8f5.neon.tech/db', DATABASE_ENV: 'development' })).toBe('declared-nonprod')
  })
})

describe('guardNeonClient (active: local + prod host)', () => {
  const PROD = 'postgresql://u:p@ep-morning-base-adq5h6rq-pooler.c-2.aws.neon.tech/neondb'
  afterEach(() => vi.unstubAllEnvs())
  function fakeClient() {
    const calls: Array<[string, unknown]> = []
    const fn = Object.assign(
      (...args: unknown[]) => { calls.push(['call', args[0]]); return 'R' },
      {
        query: (text: unknown) => { calls.push(['query', text]); return 'Q' },
        transaction: (qs: unknown) => { calls.push(['tx', qs]); return 'T' },
      },
    )
    return { fn, calls }
  }
  function activate() {
    vi.stubEnv('DATABASE_URL', PROD)
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('ALLOW_PROD_DB_WRITES', '')
    expect(prodWriteGuardActive()).toBe(true)
  }

  it('allows reads (tagged template + .query)', () => {
    activate()
    const { fn } = fakeClient()
    const g = guardNeonClient(fn)
    expect((g as (s: TemplateStringsArray) => unknown)(['select 1'] as unknown as TemplateStringsArray)).toBe('R')
    expect((g as unknown as { query: (t: string) => unknown }).query('select * from t')).toBe('Q')
  })

  it('blocks writes (tagged template, .query, and transaction)', () => {
    activate()
    const { fn } = fakeClient()
    const g = guardNeonClient(fn) as unknown as ((s: string) => unknown) & { query: (t: string) => unknown; transaction: (q: unknown[]) => unknown }
    expect(() => g('insert into service_orders (id) values (1)')).toThrow(/PRODUCTION/)
    expect(() => g.query("update service_orders set status='delivered'")).toThrow(/PRODUCTION/)
    expect(() => g.transaction([{ query: 'delete from t' }])).toThrow(/PRODUCTION/)
  })

  it('the deployed production app is never blocked: exact Vercel production env → same client, writes pass', () => {
    // Mirrors the live project: DATABASE_URL = prod endpoint, DATABASE_ENV unset, Vercel system env present.
    vi.stubEnv('DATABASE_URL', PROD)
    vi.stubEnv('DATABASE_ENV', '')
    vi.stubEnv('ALLOW_PROD_DB_WRITES', '')
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(prodWriteGuardActive()).toBe(false)
    const { fn, calls } = fakeClient()
    const g = guardNeonClient(fn)
    expect(g).toBe(fn) // no Proxy at all on Vercel
    expect(g("insert into appointments (id) values ('x')" as unknown as never)).toBe('R')
    expect(fn.query("update service_orders set status='delivered'")).toBe('Q')
    expect(fn.transaction([{ query: 'delete from t' }])).toBe('T')
    expect(calls).toHaveLength(3)
  })

  it('a local script against the prod URL (no VERCEL) is blocked even when DATABASE_ENV is empty', () => {
    vi.stubEnv('DATABASE_URL', PROD)
    vi.stubEnv('DATABASE_ENV', '')
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('ALLOW_PROD_DB_WRITES', '')
    const { fn } = fakeClient()
    const g = guardNeonClient(fn) as unknown as (s: string) => unknown
    expect(() => g('insert into appointments (id) values (1)')).toThrow(/PRODUCTION/)
    expect(g('select 1')).toBe('R')
  })

  it('returns the client unchanged when inert (declared dev branch)', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@ep-dev-xyz.c-2.aws.neon.tech/neondb')
    vi.stubEnv('DATABASE_ENV', 'development')
    const { fn } = fakeClient()
    expect(guardNeonClient(fn)).toBe(fn) // same reference, no Proxy
  })
})

describe('queryTextFrom', () => {
  it('extracts text from the shapes drizzle/neon pass', () => {
    expect(queryTextFrom('select 1')).toBe('select 1')
    expect(queryTextFrom(['select ', ' from t'])).toContain('select')
    expect(queryTextFrom({ query: 'update t set a=1' })).toBe('update t set a=1')
    expect(queryTextFrom({ sql: 'delete from t' })).toBe('delete from t')
    expect(queryTextFrom(null)).toBe('')
  })
})
