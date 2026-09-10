/**
 * GET /api/checks/jobs/[jobId] — status of a single print job (used to poll a VOID test page that has
 * no underlying check). Manager-only. No sensitive data.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { getJob } from '@/apps/checks/print-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { jobId } = await params
  const job = await getJob(jobId)
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ id: job.id, status: job.status, kind: job.kind, error: job.error, printedAt: job.printedAt })
}
