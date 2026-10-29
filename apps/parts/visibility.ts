/**
 * Reversible rollout gate for the parts UI — the Job-detail **Parts** controls and the Work Board
 * **WAITING ON PARTS** badge.
 *
 * With both rollout flags OFF, only managers/admins see parts. Employees gain visibility through
 * this legacy flag or the shared screenshot-import flag below. Both flags default OFF.
 *
 * Flip with env `PARTS_EMPLOYEE_VISIBLE=true` (also accepts 1/on/yes). Fully reversible: it is a pure
 * env read with NO code change and NO data migration — parts rows are always preserved; this only
 * governs WHO SEES them. Edge- and Node-safe.
 */
export function partsEmployeeVisible(): boolean {
  const v = (process.env.PARTS_EMPLOYEE_VISIBLE ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'on' || v === 'yes'
}

/**
 * Is the parts UI visible to a viewer with this manager status?
 *   - managers/admins: always;
 *   - the legacy employee rollout flag (`PARTS_EMPLOYEE_VISIBLE`) still reveals the manual tracker to employees;
 *   - the shared screenshot-import workflow (`PARTS_SCREENSHOT_IMPORT_ENABLED`) is an EQUAL-permission feature,
 *     so when it is on Parts is visible to every authorized shop user (employees included) even if the legacy
 *     flag is off. With the import flag off, the old rollout behavior is preserved exactly.
 */
export function partsVisibleFor(manager: boolean): boolean {
  return manager || partsEmployeeVisible() || partsScreenshotImportEnabled()
}

/**
 * DEFAULT-OFF gate for "import parts from a PartsTech screenshot" (upload a gallery screenshot → AI reads
 * the line items → the shop user reviews prices → saves tracked parts). Enabling this shared workflow also
 * reveals Parts to authenticated employees through partsVisibleFor(). The manual tracker's existing
 * billing/sell/credit permissions remain unchanged.
 *
 * Flip with env `PARTS_SCREENSHOT_IMPORT_ENABLED=true` (also accepts 1/on/yes). Fully reversible: a pure
 * env read, NO code change and NO data migration. It is read with no dependency on `app_settings`/the DB so
 * the kill-switch works even if the settings table is unreachable. Edge- and Node-safe.
 */
export function partsScreenshotImportEnabled(): boolean {
  const v = (process.env.PARTS_SCREENSHOT_IMPORT_ENABLED ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'on' || v === 'yes'
}
