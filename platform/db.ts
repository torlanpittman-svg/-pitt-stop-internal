import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import * as schema from '@/drizzle/schema'

export function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not configured.\n' +
        'Run "vercel env pull .env.local" or add it to .env.local.\n' +
        'See .env.local.example for all required variables.'
    )
  }
  return drizzle(neon(process.env.DATABASE_URL), { schema })
}
