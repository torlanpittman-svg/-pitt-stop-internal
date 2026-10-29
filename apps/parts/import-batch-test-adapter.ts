/**
 * TEST-ONLY batch adapter for the parts-import tests. NOT imported by any production/runtime code path.
 *
 * In production `getDb()` is the Neon HTTP Drizzle client, whose `db.batch([...])` runs the statements inside
 * one noninteractive `client.transaction(...)` (guard-covered) — that is the real per-job transaction used by
 * `applyImport`. PGlite's Drizzle driver does not expose `batch`, so this attaches a FAITHFUL one: it takes
 * the exact `{ sql, params }` of each Drizzle statement (`PgRaw.getQuery()`) and runs them SEQUENTIALLY in a
 * single `PGlite.transaction(...)`, returning the raw per-statement results (same positional shape callers
 * read with `rowsOf`). No Promise.all, no no-op fake, no production fallback — just a real single transaction.
 */
import type { PGlite } from '@electric-sql/pglite'

interface Built { sql: string; params: unknown[] }
interface Batchable { getQuery(): Built }

/** Attach a faithful `batch` to a PGlite-backed Drizzle db for tests. Returns the same db. */
export function attachTestBatch<D extends object>(db: D, pg: PGlite): D {
  const run = async (items: unknown[]): Promise<unknown[]> => {
    const built = (items as Batchable[]).map((it) => it.getQuery())
    return pg.transaction(async (tx) => {
      const out: unknown[] = []
      for (const q of built) out.push(await tx.query(q.sql, (q.params ?? []) as unknown[]))
      return out
    })
  }
  Object.defineProperty(db, 'batch', { value: run, configurable: true, writable: true })
  return db
}
