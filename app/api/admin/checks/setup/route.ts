/**
 * /api/admin/checks/setup — OWNER setup for Write-a-Check (admin-gated by proxy ADMIN_PASSWORD).
 *   GET  — current config + readiness (what is still missing) + sequence peeks.
 *   POST — save any of: checks_enabled, operating/auto_sales bank QBO id + label, category→expense
 *          account map, print calibration (layout). Never accepts a raw bank/account NUMBER — only QBO
 *          Account.Id references chosen from the account list. Each write is attributed.
 */
import { NextResponse } from 'next/server'
import { managerFromRequest } from '@/apps/checks/authz'
import { getCheckConfig, checkConfigReadiness } from '@/apps/checks/config'
import { updateSetting } from '@/apps/settings/db'
import { peekNextNumber } from '@/apps/checks/numbering'
import { CHECK_CATEGORIES } from '@/apps/checks/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const cfg = await getCheckConfig()
  return NextResponse.json({
    config: {
      enabled: cfg.enabled,
      banks: cfg.banks,
      categoryAccounts: cfg.categoryAccounts,
      layout: cfg.layout,
    },
    categories: CHECK_CATEGORIES,
    readiness: checkConfigReadiness(cfg),
    sequences: {
      operating: await peekNextNumber('operating'),
      auto_sales: await peekNextNumber('auto_sales'),
    },
  })
}

interface SetupBody {
  enabled?: boolean
  operatingBankQboId?: string
  operatingBankLabel?: string
  autoSalesBankQboId?: string
  autoSalesBankLabel?: string
  categoryAccounts?: Record<string, string>
  layout?: unknown
}

export async function POST(req: Request) {
  const actor = await managerFromRequest(req)
  if (!actor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  let body: SetupBody
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
  const who = actor.name ?? 'admin'

  const ops: Promise<void>[] = []
  if (typeof body.enabled === 'boolean') ops.push(updateSetting('checks_enabled', body.enabled, who))
  if (typeof body.operatingBankQboId === 'string') ops.push(updateSetting('check_operating_bank_qbo_id', body.operatingBankQboId.trim(), who))
  if (typeof body.operatingBankLabel === 'string') ops.push(updateSetting('check_operating_bank_label', body.operatingBankLabel.trim(), who))
  if (typeof body.autoSalesBankQboId === 'string') ops.push(updateSetting('check_autosales_bank_qbo_id', body.autoSalesBankQboId.trim(), who))
  if (typeof body.autoSalesBankLabel === 'string') ops.push(updateSetting('check_autosales_bank_label', body.autoSalesBankLabel.trim(), who))
  if (body.categoryAccounts && typeof body.categoryAccounts === 'object') {
    // Keep only known category keys → string account ids.
    const known = new Set(CHECK_CATEGORIES.map((c) => c.key as string))
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(body.categoryAccounts)) if (known.has(k) && v) clean[k] = String(v)
    ops.push(updateSetting('check_category_accounts', clean, who))
  }
  if (body.layout && typeof body.layout === 'object') ops.push(updateSetting('check_layout', body.layout, who))

  await Promise.all(ops)
  const cfg = await getCheckConfig()
  return NextResponse.json({ ok: true, config: { enabled: cfg.enabled, banks: cfg.banks, categoryAccounts: cfg.categoryAccounts, layout: cfg.layout }, readiness: checkConfigReadiness(cfg) })
}
