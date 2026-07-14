import { NextResponse } from 'next/server'
import { getDb } from '@/platform/db'
import { pilotInterventions } from '@/apps/vehicle-entry/schema'
import { desc } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ interventions: [] })
  }
  const db   = getDb()
  const rows = await db
    .select()
    .from(pilotInterventions)
    .orderBy(desc(pilotInterventions.createdAt))
  return NextResponse.json({ interventions: rows })
}

export async function POST(request: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const type   = typeof body.type   === 'string' ? body.type   : null
  const reason = typeof body.reason === 'string' ? body.reason : null

  if (type !== 'help_requested' && type !== 'manager_touched') {
    return NextResponse.json({ error: 'type must be help_requested or manager_touched' }, { status: 400 })
  }

  const db  = getDb()
  const [row] = await db
    .insert(pilotInterventions)
    .values({ type, reason })
    .returning()

  return NextResponse.json(row, { status: 201 })
}
