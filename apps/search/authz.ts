/**
 * Search authorization scope (PURE — unit-tested).
 *
 * Search must NEVER let a user discover data they could not otherwise reach. The scope here is the
 * SERVER-SIDE allow-list of categories a role may receive; the API filters every result set through it
 * (defence-in-depth on top of proxy.ts, which already requires an employee session for the endpoint).
 *
 *   anonymous / no session → NOTHING (fail closed)
 *   employee               → customers, vehicles, jobs, auto_sales
 *   manager / admin        → the above PLUS the financial categories: receipts, checks
 *
 * Checks follow the existing Write-a-Check permission (manager-only); receipts (Auto-Sales financial
 * documents, which expose amounts) are likewise manager-only. This is at least as strict as every
 * existing surface — it never widens who can see financial data.
 */
import { CATEGORY_ORDER, MANAGER_ONLY_CATEGORIES, type SearchCategory } from './types'
import type { EmployeeRole } from '@/apps/auth/employee-session'

export interface SearchScope {
  authenticated: boolean
  role: EmployeeRole | null
  categories: ReadonlySet<SearchCategory>
}

const EMPTY_SCOPE: SearchScope = { authenticated: false, role: null, categories: new Set() }

function isManager(role: EmployeeRole | null | undefined): boolean {
  return role === 'manager' || role === 'admin'
}

/**
 * Derive the allowed category scope for an actor. `role` null (anonymous, OR an authenticated-but-
 * anonymous legacy session) with authenticated=false yields the empty scope. A signed-in ordinary
 * employee gets the operational categories; a manager/admin additionally gets the financial ones.
 */
export function scopeForRole(role: EmployeeRole | null, authenticated: boolean): SearchScope {
  if (!authenticated) return EMPTY_SCOPE
  const categories = new Set<SearchCategory>()
  for (const c of CATEGORY_ORDER) {
    if (MANAGER_ONLY_CATEGORIES.has(c) && !isManager(role)) continue
    categories.add(c)
  }
  return { authenticated: true, role, categories }
}

export function scopeAllows(scope: SearchScope, category: SearchCategory): boolean {
  return scope.categories.has(category)
}
