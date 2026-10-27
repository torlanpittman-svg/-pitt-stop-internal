import { NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { managerFromRequest } from '@/apps/checks/authz'
import { withIntakeLock, moveIntakeToBoard, cancelIntakeEstimate } from '@/apps/estimates/db'
import { intakeSummary, refreshIntake, sendIntakeEstimate } from '@/apps/estimates/quickbooks'
import { saveCustomerNotes } from '@/apps/estimates/notes-db'
import { saveSavedRecipients } from '@/apps/estimates/recipients-db'
import { normalizeRecipients, recipientErrorMessage } from '@/apps/estimates/recipients'
import { validateCustomerNotes, customerNotesErrorMessage } from '@/apps/estimates/notes'
import { quickEntryJobs } from '@/apps/quick-entry/schema'
import { getDb } from '@/platform/db'
import { estimateEnabled } from '@/apps/workflow/estimate'
import { renameOrderCustomer, CUSTOMER_NAME_MAX } from '@/apps/workflow/customer-name'

export const maxDuration = 120
const actionInput = z.discriminatedUnion('action', [
  // `recipients` is this send's explicit address list (per-send choice, not the stored contact). Omitted →
  // default to the saved contact email. Raw strings are bounded here; normalize/dedupe/validate + placeholder
  // + empty-list rejection happen in sendIntakeEstimate before any QuickBooks call.
  z.object({ action: z.literal('send'), revision: z.string().length(64), recipients: z.array(z.string().max(254)).max(50).optional() }),
  z.object({ action: z.literal('convert'), revision: z.string().length(64) }),
  // Customer-visible notes (claim number etc.). Raw string is loosely bounded here; the real 700-char
  // bound + normalization + control-char rejection happen in validateCustomerNotes before any write.
  z.object({ action: z.literal('notes'), revision: z.string().length(64), notes: z.string().max(2000) }),
  // Durable per-estimate SEND recipients (auto-saved as the manager edits them). Raw rows are loosely
  // bounded here; blanks are dropped and the real normalize/dedupe/validate happens below. An all-blank list
  // is the EXPLICIT cleared ([]) state. This never sends anything or touches QuickBooks / pricing / contact.
  z.object({ action: z.literal('save_recipients'), revision: z.string().length(64), recipients: z.array(z.string().max(254)).max(50) }),
  z.object({ action: z.literal('contact'), email: z.union([z.email().max(200), z.literal('')]), phone: z.string().max(40) }),
  z.object({ action: z.literal('customer_name'), name: z.string().trim().min(1).max(CUSTOMER_NAME_MAX) }),
  z.object({ action: z.literal('cancel') }),
])
const safeSummary = (s: Awaited<ReturnType<typeof intakeSummary>>) => ({
  ok: true, draft: s.draft, revision: s.revision, status: s.order.status, customerName: s.order.customerName ?? '',
  email: s.contact?.customerEmail ?? '', phone: s.contact?.customerPhone ?? '',
  customerNotes: s.full?.estimate.customerNotes ?? '',
  savedRecipients: s.savedRecipients ?? null,
  qbNumber: s.intake.qbEstimateNumber, sentAt: s.intake.sentAt,
})
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await managerFromRequest(req)) return NextResponse.json({ error: 'Manager access required.' }, { status: 403 })
  const { id } = await params
  if (!estimateEnabled() || !z.uuid().safeParse(id).success) return NextResponse.json({ error: 'Estimate not found.' }, { status: 404 })
  try { return NextResponse.json(safeSummary(await intakeSummary(id))) }
  catch { return NextResponse.json({ error: 'Unable to load estimate.' }, { status: 500 }) }
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'Manager access required.' }, { status: 403 })
  const { id } = await params
  if (!estimateEnabled() || !z.uuid().safeParse(id).success) return NextResponse.json({ error: 'Estimate not found.' }, { status: 404 })
  const parsed = actionInput.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid estimate action.' }, { status: 400 })
  try {
    return await withIntakeLock(id, async () => {
      const body = parsed.data
      if (body.action === 'cancel') {
        // Direct soft cancel (never via the Work Board). No QuickBooks call, no send. Idempotent.
        const r = await cancelIntakeEstimate(id, actor.name)
        return NextResponse.json({ ok: true, cancelled: true, alreadyCancelled: r.alreadyCancelled, status: 'cancelled' })
      }
      const state = await intakeSummary(id)
      if (state.order.status === 'cancelled') throw new Error('This estimate was cancelled. It is kept for history and can’t be changed.')
      if (state.order.status !== 'estimate') {
        if (body.action === 'convert' && state.full?.estimate.convertedAt) return NextResponse.json({ ok: true, converted: true })
        throw new Error('This estimate has already moved onto the Work Board.')
      }
      if (body.action === 'contact') {
        await getDb().update(quickEntryJobs).set({ customerEmail: body.email || null, customerPhone: body.phone || null }).where(eq(quickEntryJobs.serviceOrderId, id))
      } else if (body.action === 'customer_name') {
        // Spelling correction in place: same customer/estimate ids and links (see customer-name.ts).
        await renameOrderCustomer(id, body.name, actor.name)
      } else {
        // Revision-gated actions. The stale-revision guard runs under the intake lock, so a note save can
        // never blindly overwrite an estimate someone else changed first (its revision would no longer match).
        if (state.revision !== body.revision) throw new Error('The estimate changed. Refresh and review it before continuing.')
        if (body.action === 'send') await sendIntakeEstimate(id, actor.name, body.revision, body.recipients)
        else if (body.action === 'notes') {
          if (!state.full) throw new Error('This estimate is not ready for notes yet.')
          const check = validateCustomerNotes(body.notes)
          if (!check.ok) throw new Error(customerNotesErrorMessage(check.reason))
          // Notes never change pricing, so skip the recompute refreshIntake does — return a fresh summary
          // (which re-derives the revision, now reflecting the saved notes) without mutating totals.
          await saveCustomerNotes({ orderId: id, estimateId: state.full.estimate.id, notes: check.notes, actor: actor.name })
          return NextResponse.json(safeSummary(await intakeSummary(id)))
        }
        else if (body.action === 'save_recipients') {
          // Drop blanks (a half-filled row never blocks the rest), then normalize/validate the remainder with
          // the SAME helper the send uses. All-blank → the explicit cleared [] state. An invalid/over-bound
          // entry fails CLOSED (nothing persisted). No QuickBooks call, no send, no pricing/contact change.
          const nonBlank = body.recipients.map((r) => r.trim()).filter((r) => r.length > 0)
          let list: string[] = []
          if (nonBlank.length > 0) {
            const norm = normalizeRecipients(nonBlank)
            if (!norm.ok) throw new Error(recipientErrorMessage(norm.reason))
            list = norm.list
          }
          await saveSavedRecipients({ orderId: id, recipients: list, actor: actor.name })
          return NextResponse.json(safeSummary(await intakeSummary(id)))
        }
        else {
          await moveIntakeToBoard(id, actor.name)
          return NextResponse.json({ ok: true, converted: true })
        }
      }
      return NextResponse.json(safeSummary(await refreshIntake(id)))
    })
  } catch (e) {
    // QB errors can contain response bodies; return a useful, bounded error without exposing them.
    const message = e instanceof Error ? e.message : 'Estimate action failed.'
    return NextResponse.json({ error: message.startsWith('QuickBooks API') ? 'QuickBooks could not complete the request. Retry to recover the same estimate.' : message }, { status: 409 })
  }
}
