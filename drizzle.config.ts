import type { Config } from 'drizzle-kit'

// Migrations run as the database OWNER (DDL + object ownership), never as the app role.
// DATABASE_URL_OWNER is kept only in the main checkout's git-ignored .env.local — it is not a
// Vercel variable and is not the app's APP_DATABASE_URL. No fallback on purpose.
const url = process.env.DATABASE_URL_OWNER
if (!url) {
  throw new Error(
    'DATABASE_URL_OWNER is not set. Migrations need the neondb_owner connection string ' +
    '(see docs/DB_CREDENTIAL_ROTATION_COMPLETED_2026-11-03.md). They never run on APP_DATABASE_URL.'
  )
}

export default {
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
} satisfies Config
