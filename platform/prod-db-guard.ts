/**
 * Production-DB write guard.
 *
 * `.env.local` currently points local `next dev` at the PRODUCTION Neon database, so a stray
 * UI click (or script) writes real business data. This guard blocks WRITES when a *local*
 * process (not a Vercel deployment) is connected to the known production database. Reads are
 * always allowed so local read-only browsing still works.
 *
 * It is inert in production (Vercel sets `VERCEL`), inert when pointed at any non-prod database
 * (e.g. a dedicated dev branch), and can be explicitly overridden for a deliberate, acknowledged
 * operation with `ALLOW_PROD_DB_WRITES=1` (e.g. a migration or a one-off correction).
 *
 * SCOPE: this protects the Postgres DATABASE ONLY. It does NOT protect against other external
 * side effects — QuickBooks writes, Plaid, or email/SMS. Those have their own controls (QB uses
 * `QUICKBOOKS_ENVIRONMENT=sandbox` locally; send is behind `retail_qb_send_enabled`; there is no
 * SMS infra). The host marker matches BOTH the pooled (`-pooler`) and direct Neon endpoints.
 *
 * Every neon() client — in `getDb()` and in scripts — should be wrapped with `guardNeonClient()`
 * so no DB access path bypasses the guard.
 */

// Host substring that identifies the known production Neon endpoint. This is now only ONE of the
// signals (a belt-and-suspenders fast-path), NOT the sole basis for protection — the guard is
// fail-closed on any database whose environment is not POSITIVELY declared non-prod (see
// classifyDbTarget). Overridable so the marker isn't hard-coded forever.
const PROD_HOST_MARKER = process.env.PROD_DB_HOST_MARKER || 'ep-morning-base-adq5h6rq'

export function isKnownProdUrl(url: string | undefined | null): boolean {
  return !!url && url.includes(PROD_HOST_MARKER)
}

/** Parse the Neon endpoint id (the part that differs between branches) from a connection URL. */
export function dbEndpointId(url: string | undefined | null): string {
  try { return new URL(url ?? '').hostname.split('.')[0] || '(invalid DATABASE_URL)' }
  catch { return '(invalid DATABASE_URL)' }
}

export type DbClassification = 'production' | 'declared-nonprod' | 'unknown'

// Values of DATABASE_ENV (or legacy APP_DB_ENV) that positively declare a NON-production branch.
const NONPROD_DECLARATIONS = new Set(['development', 'dev', 'develop', 'preview', 'test', 'local', 'staging'])
const PROD_DECLARATIONS = new Set(['production', 'prod'])

function dbEnvDeclaration(env: Record<string, string | undefined>): string | null {
  const raw = (env.DATABASE_ENV ?? env.APP_DB_ENV ?? '').trim().toLowerCase()
  return raw || null
}

/**
 * Classify the database a process is about to touch. The key property is that an UNDECLARED target
 * is `unknown` — NOT silently "non-prod". The old guard keyed only on one hard-coded prod hostname,
 * so a brand-new/unknown endpoint (e.g. a mis-pulled dev-branch URL) was treated as safe and writes
 * went through silently. Now a target is "safe to write from a local process" ONLY when it is
 * explicitly declared non-prod via DATABASE_ENV AND is not the known prod host.
 */
export function classifyDbTarget(env: Record<string, string | undefined> = process.env): DbClassification {
  if (isKnownProdUrl(env.DATABASE_URL)) return 'production'
  const decl = dbEnvDeclaration(env)
  if (decl && PROD_DECLARATIONS.has(decl)) return 'production'
  if (decl && NONPROD_DECLARATIONS.has(decl)) return 'declared-nonprod'
  return 'unknown'
}

/** A clear, printable description of the effective DB target (never includes credentials). */
export function describeDbTarget(env: Record<string, string | undefined> = process.env): {
  endpoint: string; classification: DbClassification; deployed: boolean; writesBlocked: boolean
} {
  return {
    endpoint: dbEndpointId(env.DATABASE_URL),
    classification: classifyDbTarget(env),
    deployed: !!env.VERCEL,
    writesBlocked: prodWriteGuardActive(env),
  }
}

/**
 * True when writes must be BLOCKED. Fail-closed: a LOCAL process may only write to a database that
 * is POSITIVELY declared non-prod. Production and UNKNOWN (undeclared) targets are both blocked
 * unless explicitly acknowledged with ALLOW_PROD_DB_WRITES=1. Inert on Vercel (deployed infra).
 */
export function prodWriteGuardActive(env: Record<string, string | undefined> = process.env): boolean {
  if (env.ALLOW_PROD_DB_WRITES === '1') return false
  if (env.VERCEL) return false // set on Vercel builds/runtime; unset for local dev + scripts
  return classifyDbTarget(env) !== 'declared-nonprod'
}

/**
 * Classify a SQL statement as a write (mutation/DDL) vs a read. Conservative: anything that is
 * not clearly read-only is treated as a write. ORM-generated SQL always leads with its verb, so
 * leading-keyword classification is reliable; a data-modifying CTE (`WITH x AS (UPDATE …)`) is
 * also caught.
 */
export function isWriteSql(sql: string): boolean {
  // Strip leading comments/whitespace so we classify the first real statement.
  const s = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '').trim()
  if (!s) return false
  // Read-only leaders. (SET = session config, BEGIN/COMMIT/ROLLBACK = tx control — the actual
  // writes inside a transaction are separate statements, each classified on its own.)
  const READ_ONLY = /^(SELECT|EXPLAIN|SHOW|VALUES|TABLE|FETCH|CLOSE|DECLARE|SET|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i
  if (READ_ONLY.test(s)) return false
  if (/^WITH\b/i.test(s)) {
    // A CTE is a write only if it contains a data-modifying statement.
    return /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(s)
  }
  const WRITE = /^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|REFRESH|REINDEX|VACUUM|CALL|COPY|LOCK|DO|IMPORT|REPLACE)\b/i
  return WRITE.test(s)
}

export const PROD_WRITE_BLOCK_MESSAGE =
  'Blocked a WRITE to the PRODUCTION database from a local process.\n' +
  '.env.local DATABASE_URL points at the production Neon branch, so local writes would mutate ' +
  'real business data. Point DATABASE_URL at a dedicated dev branch for write-testing, or set ' +
  'ALLOW_PROD_DB_WRITES=1 for a deliberate, acknowledged operation. (Reads are allowed.)'

/** Classification-aware block message — names the endpoint and why it was blocked. */
export function blockWriteMessage(env: Record<string, string | undefined> = process.env): string {
  const ep = dbEndpointId(env.DATABASE_URL)
  const cls = classifyDbTarget(env)
  if (cls === 'production') {
    return `Blocked a WRITE to the PRODUCTION database (endpoint ${ep}) from a local process. ` +
      'Set ALLOW_PROD_DB_WRITES=1 for a deliberate, acknowledged operation, or point DATABASE_URL ' +
      'at a dev branch and set DATABASE_ENV=development. (Reads are allowed.)'
  }
  // unknown: fail-closed — treated as PRODUCTION until positively declared otherwise.
  return `Blocked a WRITE to an UNDECLARED database (endpoint ${ep}). Its environment is UNKNOWN, ` +
    'so it is treated as PRODUCTION (fail-closed). If this is a real dev branch, declare it with ' +
    'DATABASE_ENV=development; for a deliberate prod write set ALLOW_PROD_DB_WRITES=1. (Reads are allowed.)'
}

/** Extract query text from the various shapes drizzle/neon pass (string, template array, query obj). */
export function queryTextFrom(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (Array.isArray(arg)) return arg.join(' ') // tagged-template strings
  if (arg && typeof arg === 'object') {
    const o = arg as Record<string, unknown>
    for (const k of ['query', 'sql', 'text']) if (typeof o[k] === 'string') return o[k] as string
  }
  return ''
}

let warned = false

/**
 * Wrap a neon() client so WRITES throw when the guard is active (see `prodWriteGuardActive`).
 * drizzle's neon-http session builds every query — including each statement inside a transaction —
 * through `client.query(sql, …)` (falling back to calling the client directly), and raw scripts
 * call the client as a tagged template; both paths are classified here. Returns the client
 * unchanged when the guard is inert (production, a dev branch, or an explicit override).
 */
export function guardNeonClient<T extends object>(client: T): T {
  if (!prodWriteGuardActive()) return client
  if (!warned) {
    warned = true
    const { endpoint, classification } = describeDbTarget()
    console.warn(
      `[db] Local process connected to endpoint "${endpoint}" classified as ${classification.toUpperCase()} — ` +
        'writes are BLOCKED (reads allowed). Declare DATABASE_ENV=development for a real dev branch, ' +
        'or set ALLOW_PROD_DB_WRITES=1 for a deliberate, acknowledged operation.',
    )
  }
  const assertRead = (text: string) => {
    if (isWriteSql(text)) throw new Error(blockWriteMessage())
  }
  return new Proxy(client, {
    apply(target, thisArg, args: unknown[]) {
      assertRead(queryTextFrom(args[0]))
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args)
    },
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver)
      if (prop === 'query' && typeof val === 'function') {
        return (text: unknown, params?: unknown, opts?: unknown) => {
          assertRead(queryTextFrom(text))
          return (val as (...a: unknown[]) => unknown).call(target, text, params, opts)
        }
      }
      if (prop === 'transaction' && typeof val === 'function') {
        return (queries: unknown, opts?: unknown) => {
          for (const q of Array.isArray(queries) ? queries : []) assertRead(queryTextFrom(q))
          return (val as (...a: unknown[]) => unknown).call(target, queries, opts)
        }
      }
      return val
    },
  }) as T
}
