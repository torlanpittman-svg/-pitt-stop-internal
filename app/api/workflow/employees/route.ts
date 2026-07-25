import { NextResponse } from 'next/server'
import { listEmployees, createEmployee, deactivateEmployee } from '@/apps/workflow/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const list = await listEmployees()
    return NextResponse.json({ employees: list })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { name?: string; action?: string; id?: string }

    if (body.action === 'deactivate' && body.id) {
      await deactivateEmployee(body.id)
      return NextResponse.json({ ok: true })
    }

    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name required' }, { status: 400 })
    }

    const employee = await createEmployee(body.name.trim())
    return NextResponse.json({ employee }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
