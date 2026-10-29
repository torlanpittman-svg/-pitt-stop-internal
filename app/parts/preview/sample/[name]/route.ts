/**
 * DEV-ONLY sample screenshot server for the Parts preview harness. Serves ONLY the two synthetic fixture
 * PNGs (fixed allowlist) from scripts/parts-preview/assets so the preview can compare extracted rows to the
 * actual source images. Returns 404 in production and for any name outside the allowlist — it never exposes
 * arbitrary files and is never part of the production app.
 */
import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOW: Record<string, string> = { order: 'sample-order.png', quote: 'sample-quote.png' }

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  if (process.env.NODE_ENV === 'production') return new NextResponse('Not found', { status: 404 })
  const { name } = await params
  const file = ALLOW[name]
  if (!file) return new NextResponse('Not found', { status: 404 })
  try {
    const bytes = await readFile(path.join(process.cwd(), 'scripts', 'parts-preview', 'assets', file))
    return new NextResponse(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }
}
