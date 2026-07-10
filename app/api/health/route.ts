import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'pitt-stop-internal',
    timestamp: new Date().toISOString(),
  })
}
