/**
 * Preview-deployment safety — FAIL CLOSED.
 *
 * A Vercel PREVIEW build runs unreleased branch code. If its database or file-storage settings point at
 * production, that unreleased code can read and change real customer and financial data. So a preview only
 * gets a database when the target is POSITIVELY non-production, and only gets file storage when an isolated
 * store has been declared:
 *
 *   database : APP_DATABASE_URL must NOT be the known production endpoint AND DATABASE_ENV must declare a
 *              non-production target (development | dev | preview | test | staging). Otherwise every query
 *              is refused — reads included.
 *   storage  : PREVIEW_STORAGE_ISOLATED=1 must be set (by whoever configures a separate Blob store for the
 *              preview environment). Otherwise every upload / read is refused.
 *
 * Production and local development are untouched (local writes are already covered by prod-db-guard.ts).
 * Pure functions; no secrets are read into messages or logs.
 */
import { classifyDbTarget, isKnownProdUrl } from './prod-db-guard'

type Env = Record<string, string | undefined>

/** True only for a deployed Vercel preview (or any deployed non-production, non-development target). */
export function isPreviewDeployment(env: Env = process.env): boolean {
  if (!env.VERCEL) return false
  const v = (env.VERCEL_ENV ?? '').toLowerCase()
  return v !== 'production' && v !== 'development' && v !== ''
}

export interface PreviewDecision { allowed: boolean; reason: string }

export function previewDbDecision(env: Env = process.env): PreviewDecision {
  if (!isPreviewDeployment(env)) return { allowed: true, reason: 'not a preview deployment' }
  if (isKnownProdUrl(env.APP_DATABASE_URL)) return { allowed: false, reason: 'the preview database setting is the PRODUCTION database' }
  if (classifyDbTarget(env) !== 'declared-nonprod') return { allowed: false, reason: 'the preview database is not declared non-production (set DATABASE_ENV=preview on an isolated branch)' }
  return { allowed: true, reason: 'isolated non-production database' }
}

export function previewStorageDecision(env: Env = process.env): PreviewDecision {
  if (!isPreviewDeployment(env)) return { allowed: true, reason: 'not a preview deployment' }
  if (env.PREVIEW_STORAGE_ISOLATED === '1') return { allowed: true, reason: 'isolated preview file store declared' }
  return { allowed: false, reason: 'no isolated preview file store is declared (PREVIEW_STORAGE_ISOLATED=1), so the storage tokens may be the production store' }
}

export class PreviewBlockedError extends Error {
  constructor(what: 'database' | 'file storage', reason: string) {
    super(`Preview deployment blocked from ${what}: ${reason}. This is deliberate — see docs/PREVIEW_SAFETY.md.`)
    this.name = 'PreviewBlockedError'
  }
}

/** Throws in an unsafe preview. Skipped while Next.js is BUILDING (no request is being served then). */
export function assertPreviewDbAllowed(env: Env = process.env): void {
  if (env.NEXT_PHASE === 'phase-production-build') return
  const d = previewDbDecision(env)
  if (!d.allowed) throw new PreviewBlockedError('database', d.reason)
}
export function assertPreviewStorageAllowed(env: Env = process.env): void {
  if (env.NEXT_PHASE === 'phase-production-build') return
  const d = previewStorageDecision(env)
  if (!d.allowed) throw new PreviewBlockedError('file storage', d.reason)
}

/** Non-secret summary for /api/health: which environment this is and whether data access is allowed. */
export function environmentSummary(env: Env = process.env) {
  const db = previewDbDecision(env), storage = previewStorageDecision(env)
  return {
    vercelEnv: env.VERCEL ? (env.VERCEL_ENV ?? 'unknown') : 'local',
    commit: (env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7) || null,
    databaseTarget: !env.APP_DATABASE_URL ? 'not-configured' : isKnownProdUrl(env.APP_DATABASE_URL) ? 'production' : classifyDbTarget(env) === 'declared-nonprod' ? 'declared-non-production' : 'unknown',
    storageConfigured: !!(env.BLOB_READ_WRITE_TOKEN || env.RECEIPTS_BLOB_READ_WRITE_TOKEN),
    preview: isPreviewDeployment(env),
    databaseAccess: db.allowed ? 'allowed' : 'blocked', databaseReason: db.reason,
    storageAccess: storage.allowed ? 'allowed' : 'blocked', storageReason: storage.reason,
  }
}
