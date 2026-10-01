/**
 * Reversible rollout gate for the parts UI — the Job-detail **Parts** controls and the Work Board
 * **WAITING ON PARTS** badge.
 *
 * Default OFF: only managers/admins see parts (so they can test it end-to-end), and the controls +
 * badge are HIDDEN from employees until the permanent PartsTech-backed "Find Parts" flow ships. This
 * deliberately avoids showing employees a manual-first parts workflow in the interim.
 *
 * Flip with env `PARTS_EMPLOYEE_VISIBLE=true` (also accepts 1/on/yes). Fully reversible: it is a pure
 * env read with NO code change and NO data migration — parts rows are always preserved; this only
 * governs WHO SEES them. Edge- and Node-safe.
 */
export function partsEmployeeVisible(): boolean {
  const v = (process.env.PARTS_EMPLOYEE_VISIBLE ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'on' || v === 'yes'
}

/** Is the parts UI visible to a viewer with this manager status? Managers/admins: always. */
export function partsVisibleFor(manager: boolean): boolean {
  return manager || partsEmployeeVisible()
}
