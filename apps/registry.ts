/**
 * Pitt Stop OS — Application Registry
 *
 * This is the single source of truth for every app on the platform.
 * The launcher, admin hub, and any platform nav all derive from this list.
 *
 * To add a new app:
 *   1. Create  apps/<name>/manifest.ts
 *   2. Import and add it below — one line
 *   3. Set enabled: true in the manifest when routes are ready
 */

import type { AppManifest } from './types'
import { vehicleEntryApp } from './vehicle-entry/manifest'
import { estimatorApp }    from './estimator/manifest'

// Future apps — uncomment as they are built:
// import { sopHandbookApp }    from './sop-handbook/manifest'
// import { qualityControlApp } from './quality-control/manifest'
// import { quickbooksApp }     from './quickbooks/manifest'
// import { inventoryApp }      from './inventory/manifest'
// import { customerIntakeApp } from './customer-intake/manifest'
// import { photoManagementApp } from './photo-management/manifest'
// import { reportingApp }      from './reporting/manifest'
// import { financeApp }        from './finance/manifest'

export const APP_REGISTRY: AppManifest[] = [
  vehicleEntryApp,
  estimatorApp,
]

export function getEnabledApps(): AppManifest[] {
  return APP_REGISTRY.filter((app) => app.enabled)
}

export function getApp(id: string): AppManifest | undefined {
  return APP_REGISTRY.find((app) => app.id === id)
}
