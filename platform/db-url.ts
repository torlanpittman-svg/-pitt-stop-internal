/**
 * The APP-OWNED database connection variable.
 *
 * Why this exists: the Neon marketplace store on Vercel manages `DATABASE_URL` (and the whole
 * `PG*` / `POSTGRES_*` family). Any secret refresh on that store — a "Reset password" in the Neon
 * console or "Rotate secrets" in Vercel — re-pushes those variables with the database OWNER
 * credential (`neondb_owner`), silently undoing the least-privilege setup of 2026-11-03
 * (see docs/DB_CREDENTIAL_ROTATION_COMPLETED_2026-11-03.md).
 *
 * So the application reads ONLY `APP_DATABASE_URL`, a hand-managed variable that no integration
 * rewrites. It must hold the `pitt_stop_app` connection string (DML only, no DDL).
 *
 * There is deliberately NO fallback to `DATABASE_URL`: a missing `APP_DATABASE_URL` fails loudly
 * rather than quietly connecting as the owner. Migrations are separate on purpose and use
 * `DATABASE_URL_OWNER` (see drizzle.config.ts).
 */

export const APP_DATABASE_URL_VAR = 'APP_DATABASE_URL'
export const OWNER_DATABASE_URL_VAR = 'DATABASE_URL_OWNER'

type Env = Record<string, string | undefined>

/** The app connection string, or undefined when not configured. Never falls back to DATABASE_URL. */
export function appDatabaseUrl(env: Env = process.env): string | undefined {
  const v = env[APP_DATABASE_URL_VAR]?.trim()
  return v ? v : undefined
}

/** True when the app has a real database (otherwise the in-memory demo store is used). */
export function hasAppDatabase(env: Env = process.env): boolean {
  return appDatabaseUrl(env) !== undefined
}

export const APP_DATABASE_URL_MISSING =
  `${APP_DATABASE_URL_VAR} is not configured.\n` +
  `Set it to the pitt_stop_app connection string (least-privilege app role) in Vercel and in .env.local.\n` +
  `It is intentionally NOT derived from DATABASE_URL: that variable is managed by the Neon integration and ` +
  `can be rewritten to the database owner credential on any secret refresh. ` +
  `See docs/DB_CREDENTIAL_ROTATION_COMPLETED_2026-11-03.md.`

/** The app connection string; throws a clear error when it is not set. */
export function requireAppDatabaseUrl(env: Env = process.env): string {
  const v = appDatabaseUrl(env)
  if (!v) throw new Error(APP_DATABASE_URL_MISSING)
  return v
}

/**
 * Host-only view of the app connection (for diagnostics). Never includes credentials.
 * Returns '' when the app URL is not configured.
 */
export function appDatabaseHost(env: Env = process.env): string {
  const v = appDatabaseUrl(env)
  if (!v) return ''
  try { return new URL(v).hostname } catch { return '(invalid APP_DATABASE_URL)' }
}
