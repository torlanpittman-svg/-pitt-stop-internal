import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import * as schema from '@/drizzle/schema'
import { guardNeonClient } from './prod-db-guard'

export function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not configured.\n' +
        'Run "vercel env pull .env.local" or add it to .env.local.\n' +
        'See .env.local.example for all required variables.'
    )
  }
  // guardNeonClient blocks writes when a LOCAL process is pointed at the known prod DB (reads pass);
  // inert in production and on a dev branch. See platform/prod-db-guard.ts.
  return drizzle(guardNeonClient(neon(process.env.DATABASE_URL)), { schema })
}
