/**
 * POST /api/checks/[id]/confirm-print — a manager settles a shop-printer job after LOOKING at the printer.
 * "Sent to the printer" is not proof of paper, so a check only becomes `printed` here.
 *
 * Body: { jobId: string, outcome: 'printed' | 'not_printed' | 'cleared' | 'cancel' }
 *   printed      the paper check came out
 *   not_printed  no check came out → the job is HELD ('stuck'); the check cannot be re-sent yet
 *   cleared      the original was removed from Windows + the printer → only now can it be sent again
 *   cancel       withdraw a job still waiting in the cloud queue (nothing has printed)
 * Never touches QuickBooks. Manager-only.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { resolvePrintJob, CheckValidationError, type ManagerPrintOutcome } from '@/apps/checks/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { id } = await params
  let body: { jobId?: string; outcome?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  const outcome = body.outcome
  if (!body.jobId || (outcome !== 'printed' && outcome !== 'not_printed' && outcome !== 'cleared' && outcome !== 'cancel')) {
    return NextResponse.json({ error: 'invalid_body', message: 'jobId and outcome (printed | not_printed | cleared | cancel) are required.' }, { status: 400 })
  }
  try {
    const check = await resolvePrintJob(id, String(body.jobId), outcome as ManagerPrintOutcome, { key: actor.key, name: actor.name })
    return NextResponse.json({ ok: true, check })
  } catch (e) {
    if (e instanceof CheckValidationError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === 'job_not_found' ? 404 : 409 })
    return NextResponse.json({ error: 'server_error', message: String((e as Error)?.message ?? e) }, { status: 500 })
  }
}
