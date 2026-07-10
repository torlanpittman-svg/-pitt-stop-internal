/**
 * Platform application registry types.
 *
 * Every app in the Pitt Stop OS implements AppManifest and registers
 * itself in apps/registry.ts. The platform shell reads from the registry
 * to build navigation, admin hubs, and any platform-level UI.
 *
 * Adding a new app:
 *   1. Create apps/<name>/manifest.ts  (implement AppManifest)
 *   2. Add it to apps/registry.ts     (one line)
 *   3. Create routes in app/<name>/   (Next.js pages)
 *   4. That's it — launcher + admin appear automatically.
 */

export interface AppRoutes {
  /** Primary employee-facing entry point */
  main: string
  /** Admin review route */
  admin: string
  /** API base path (optional) */
  api?: string
}

export interface AppManifest {
  /** Unique kebab-case identifier. Used in URLs and DB column names. */
  id: string
  /** Display name shown in launchers and admin UI */
  name: string
  /** One-line description for cards */
  description: string
  /** Semantic version for this app */
  version: string
  /** Route paths for this app */
  routes: AppRoutes
  /**
   * Set to true when the app's routes exist and it is ready for employees.
   * false = greyed-out "coming soon" card in the launcher.
   */
  enabled: boolean
}
