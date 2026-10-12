/**
 * GET /api/checks/bridge-status — is the shop print bridge online? Based on the heartbeat it records every
 * time it polls the queue. Manager-only. No sensitive data.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { getBridgeStatus } from '@/apps/checks/print-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  try {
    return NextResponse.json(await getBridgeStatus())
  } catch {
    // Heartbeat table not available yet → report unknown rather than failing the screen.
    return NextResponse.json({ online: false, bridges: [], unknown: true })
  }
}
