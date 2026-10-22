/**
 * Shared retail invoice — membership reads (DB only, no QuickBooks). Kept separate from the orchestration so the
 * retail invoice service (Sync / Send / verify) can ask "who else is on this invoice?" without an import cycle.
 */
import { and, asc, eq, ne } from 'drizzle-orm'
import { getDb } from '@/platform/db'
import { retailInvoiceMembers } from '@/apps/workflow/schema'

export type MemberRow = typeof retailInvoiceMembers.$inferSelect

/** Active (pending + applied) members of the invoice this anchor estimate owns, oldest link first. */
export async function listActiveMembers(anchorEstimateId: string): Promise<MemberRow[]> {
  return getDb().select().from(retailInvoiceMembers)
    .where(and(eq(retailInvoiceMembers.anchorEstimateId, anchorEstimateId), ne(retailInvoiceMembers.state, 'removed')))
    .orderBy(asc(retailInvoiceMembers.linkedAt), asc(retailInvoiceMembers.id))
}

/** This estimate's active membership as a MEMBER (at most one — rim_member_active_uniq). */
export async function activeMembershipOf(memberEstimateId: string): Promise<MemberRow | null> {
  const [m] = await getDb().select().from(retailInvoiceMembers)
    .where(and(eq(retailInvoiceMembers.memberEstimateId, memberEstimateId), ne(retailInvoiceMembers.state, 'removed')))
    .limit(1)
  return m ?? null
}
