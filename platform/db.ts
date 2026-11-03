import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import * as schema from '@/drizzle/schema'
import { guardNeonClient } from './prod-db-guard'
import { requireAppDatabaseUrl } from './db-url'

export function getDb() {
  // APP_DATABASE_URL only — never DATABASE_URL (integration-managed, can be re-pushed as the owner
  // credential). A missing value throws instead of falling back. See platform/db-url.ts.
  const url = requireAppDatabaseUrl()
  // guardNeonClient blocks writes when a LOCAL process is pointed at the known prod DB (reads pass);
  // inert in production and on a dev branch. See platform/prod-db-guard.ts.
  return drizzle(guardNeonClient(neon(url)), { schema })
}
