/**
 * In-memory demo store for local development without a real database.
 * Activated automatically when DATABASE_URL is not set.
 * Uses a process-level global so the Map survives across Next.js
 * module re-evaluations in dev mode (common with Turbopack/HMR).
 *
 * NOT for production — data is lost on server restart.
 */

declare global {
  // eslint-disable-next-line no-var
  var _pittStopDemoStore: Map<string, Map<string, unknown>> | undefined
}

function getRoot(): Map<string, Map<string, unknown>> {
  if (!global._pittStopDemoStore) {
    global._pittStopDemoStore = new Map()
  }
  return global._pittStopDemoStore
}

function col(collection: string): Map<string, unknown> {
  const root = getRoot()
  if (!root.has(collection)) root.set(collection, new Map())
  return root.get(collection)!
}

export const demoStore = {
  insert<T extends { id: string }>(collection: string, item: T): T {
    col(collection).set(item.id, item)
    return item
  },

  get<T>(collection: string, id: string): T | null {
    return (col(collection).get(id) as T) ?? null
  },

  list<T>(collection: string): T[] {
    return Array.from(col(collection).values()) as T[]
  },

  update<T extends Record<string, unknown>>(
    collection: string,
    id: string,
    patch: Partial<T>
  ): T | null {
    const existing = col(collection).get(id)
    if (!existing) return null
    const updated = { ...(existing as T), ...patch, id }
    col(collection).set(id, updated)
    return updated as T
  },
}
