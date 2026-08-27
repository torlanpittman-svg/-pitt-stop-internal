'use server'
/** Server actions for the Opening-Inventory Backfill (admin page is proxy-gated). Preview is a pure
 *  dry-run (matches full VIN only; fabricates nothing). Commit creates records only for confirmed
 *  rows with the minimum facts. No money movement. */
import { previewBackfill, commitBackfill, type BackfillRow, type BackfillPreview } from '@/apps/auto-sales/db'

export async function previewBackfillAction(rows: BackfillRow[]): Promise<BackfillPreview[]> {
  return previewBackfill(rows)
}
export async function commitBackfillAction(rows: (BackfillRow & { confirm: boolean })[]): Promise<{ created: number; skipped: number }> {
  return commitBackfill(rows, 'admin')
}
