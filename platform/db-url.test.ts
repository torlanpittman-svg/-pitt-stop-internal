import { describe, it, expect } from 'vitest'
import { appDatabaseUrl, hasAppDatabase, requireAppDatabaseUrl, appDatabaseHost } from './db-url'

const APP = 'postgresql://pitt_stop_app:pw@ep-morning-base-adq5h6rq-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require'
const OWNER = 'postgresql://neondb_owner:pw@ep-morning-base-adq5h6rq-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require'

describe('APP_DATABASE_URL resolver', () => {
  it('reads APP_DATABASE_URL', () => {
    expect(appDatabaseUrl({ APP_DATABASE_URL: APP })).toBe(APP)
    expect(hasAppDatabase({ APP_DATABASE_URL: APP })).toBe(true)
    expect(requireAppDatabaseUrl({ APP_DATABASE_URL: APP })).toBe(APP)
  })

  it('NEVER falls back to DATABASE_URL — a Neon-store refresh must not hand the app the owner credential', () => {
    const env = { DATABASE_URL: OWNER, DATABASE_URL_UNPOOLED: OWNER, POSTGRES_URL: OWNER }
    expect(appDatabaseUrl(env)).toBeUndefined()
    expect(hasAppDatabase(env)).toBe(false)
    expect(() => requireAppDatabaseUrl(env)).toThrow(/APP_DATABASE_URL is not configured/)
    expect(() => requireAppDatabaseUrl(env)).not.toThrow(/neondb_owner/) // the message carries no credential
  })

  it('treats blank as unset and ignores DATABASE_URL_OWNER (migrations only)', () => {
    expect(appDatabaseUrl({ APP_DATABASE_URL: '   ', DATABASE_URL_OWNER: OWNER })).toBeUndefined()
    expect(() => requireAppDatabaseUrl({ DATABASE_URL_OWNER: OWNER })).toThrow()
  })

  it('exposes the host only for diagnostics', () => {
    expect(appDatabaseHost({ APP_DATABASE_URL: APP })).toBe('ep-morning-base-adq5h6rq-pooler.c-2.us-east-1.aws.neon.tech')
    expect(appDatabaseHost({ APP_DATABASE_URL: APP })).not.toContain('pw')
    expect(appDatabaseHost({})).toBe('')
    expect(appDatabaseHost({ APP_DATABASE_URL: 'nope' })).toBe('(invalid APP_DATABASE_URL)')
  })
})
