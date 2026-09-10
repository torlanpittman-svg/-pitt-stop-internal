/**
 * Write-a-Check orchestration — the authoritative money-mutation path. Enforces the failure-state model:
 *
 *   RECORD (createAndRecordCheck):
 *     resolve payee (fail-closed) → reserve check number → persist intent → write QuickBooks Purchase/Check.
 *     • QB SUCCESS → status recorded; the check may now print.
 *     • QB FAILURE → status failed; NO negotiable check is printed; safe retry reuses the SAME row+number.
 *     • Idempotent: a replay with the same idempotencyKey returns the existing check and NEVER writes QB twice.
 *
 *   PRINT is a SEPARATE event (recordPrintResult / reprintCheck):
 *     • marks printed | print_failed; a reprint reuses the SAME row/number/QBO txn and only bumps reprintCount.
 *     • printing NEVER creates or alters a QuickBooks transaction.
 *
 * TEST PRINT does not live here — it creates no row and no QB txn (handled entirely at the print route).
 */
import { getValidAccessToken } from '@/apps/quickbooks/connection'
import { getCheckConfig, bankForCategory, checkConfigReadiness } from './config'
import { categoryDef, categoryEntity, type CheckCategoryKey, type CheckView } from './types'
import { resolveVendor } from './vendor'
import { reserveNextNumber, releaseIfLast } from './numbering'
import { createCheckInQB, findCheckByDocNumber } from './qb-check'
import {
  insertCheck, getCheckByIdempotencyKey, getCheckRow, markRecorded, markQbFailed,
  setPrintStatus, logCheckEvent, toView, getCheckView,
} from './db'
import { enqueuePrintJob, getJob, markJobPrinted, markJobFailed } from './print-queue'
import { buildCheckPayload, buildFields, testValues, PAGE_WIDTH_IN, PAGE_HEIGHT_IN, type CheckPrintPayload } from './render'
import { assembleCheckTemplate } from './template-server'
import type { BankKey } from './types'
import { logger } from '@/platform/logger'

const APP = 'checks:service'

export interface Actor { key: string | null; name: string | null }

export interface WriteCheckInput {
  payeeName: string
  vendorId?: string | null        // explicit pick from the picker (skips search)
  allowCreateVendor?: boolean      // manager confirmed "create new vendor"
  amountCents: number
  memo?: string | null
  category: CheckCategoryKey
  linkedJobId?: string | null
  linkedVehicleId?: string | null
  checkDate?: string | null        // defaults to today
  idempotencyKey: string
}

export class CheckValidationError extends Error {
  constructor(message: string, public code: string) { super(message); this.name = 'CheckValidationError' }
}

function today(): string { return new Date().toISOString().slice(0, 10) }

function validate(input: WriteCheckInput): void {
  if (!input.payeeName?.trim()) throw new CheckValidationError('Payee is required.', 'payee_required')
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new CheckValidationError('Amount must be greater than $0.00.', 'amount_invalid')
  if (input.amountCents > 100_000_00) throw new CheckValidationError('Amount exceeds the $100,000 safety limit for a single check.', 'amount_too_large')
  if (!categoryDef(input.category)) throw new CheckValidationError('Unknown category.', 'category_invalid')
  if (!input.idempotencyKey?.trim()) throw new CheckValidationError('Missing idempotency key.', 'idempotency_required')
}

/**
 * Create + record a check. See failure-state model above. Returns the check view plus whether QB
 * recording succeeded so the caller only invokes printing after a real recording.
 */
export async function createAndRecordCheck(input: WriteCheckInput, actor: Actor): Promise<{ check: CheckView; recorded: boolean; error?: string }> {
  validate(input)

  // Idempotent replay — never double-write QuickBooks or reserve a second number.
  const existing = await getCheckByIdempotencyKey(input.idempotencyKey)
  if (existing) {
    const cfg = await getCheckConfig()
    return { check: toView(existing, cfg.banks[existing.bankKey as BankKey]?.label ?? existing.bankKey), recorded: existing.qbStatus === 'recorded', error: existing.qbError ?? undefined }
  }

  const cfg = await getCheckConfig()
  const readiness = checkConfigReadiness(cfg)
  if (!readiness.ready) throw new CheckValidationError('Check-writing is not configured yet (bank account not set). Complete setup first.', 'not_configured')
  // Fail-closed on REAL side effects: no QuickBooks Purchase and no check-number consumption until the
  // owner explicitly turns on live recording (going live). The whole workflow is still walkable/testable
  // (and a VOID/non-negotiable test print stays available) — this only blocks the final money mutation.
  if (!cfg.liveEnabled) throw new CheckValidationError('Live check recording is not enabled yet — hardware/MICR setup is pending. You can preview the full workflow and send a VOID test; recording a real check is disabled.', 'live_not_enabled')

  const entity = categoryEntity(input.category)
  const bank = bankForCategory(cfg, input.category)
  if (!bank.qboAccountId) throw new CheckValidationError(`No bank account configured for ${entity === 'auto_sales' ? 'Auto Sales' : 'operating'} checks.`, 'bank_not_configured')
  const expenseAccountId = cfg.categoryAccounts[input.category]
  if (!expenseAccountId) throw new CheckValidationError(`No expense account mapped for "${categoryDef(input.category)?.label}". Finish setup.`, 'expense_not_configured')

  // Resolve payee BEFORE reserving a number so an ambiguity never burns a check number.
  const vendor = await resolveVendor(input.payeeName, { vendorId: input.vendorId ?? null, allowCreate: !!input.allowCreateVendor })

  const checkDate = input.checkDate?.trim() || today()
  const checkNumber = await reserveNextNumber(bank.key as BankKey)

  // Persist durable intent BEFORE the QB write, with the number bound. If the process dies after QB but
  // before we mark recorded, findCheckByDocNumber adopts it on retry (no duplicate).
  let checkId: string
  try {
    checkId = await insertCheck({
      checkNumber, bankKey: bank.key as BankKey, bankQboAccountId: bank.qboAccountId,
      payeeName: vendor.displayName || input.payeeName.trim(), payeeQboVendorId: vendor.id,
      amountCents: input.amountCents, memo: input.memo?.trim() || null,
      category: input.category, expenseQboAccountId: expenseAccountId, entity,
      linkedJobId: input.linkedJobId ?? null, linkedVehicleId: input.linkedVehicleId ?? null,
      checkDate, idempotencyKey: input.idempotencyKey, actorKey: actor.key, actorName: actor.name,
    })
  } catch (e) {
    // Insert failed (e.g. a concurrent request already used this number/key) — release the number.
    await releaseIfLast(bank.key as BankKey, checkNumber).catch(() => {})
    const replay = await getCheckByIdempotencyKey(input.idempotencyKey)
    if (replay) { const c = await getCheckConfig(); return { check: toView(replay, c.banks[replay.bankKey as BankKey]?.label ?? replay.bankKey), recorded: replay.qbStatus === 'recorded', error: replay.qbError ?? undefined } }
    throw e
  }
  await logCheckEvent(checkId, 'created', actor.name, { checkNumber, amountCents: input.amountCents, payee: vendor.displayName, category: input.category, bank: bank.key })

  // Provenance: bind the check to the QB realm it will hit.
  let realmId: string | null = null
  try { realmId = (await getValidAccessToken()).realmId } catch { /* recorded below via error */ }

  const recordResult = await attemptQbWrite(checkId, {
    bankAccountId: bank.qboAccountId, expenseAccountId, vendorId: vendor.id,
    amountCents: input.amountCents, docNumber: String(checkNumber), txnDate: checkDate,
    memo: input.memo?.trim() || null, lineDescription: input.memo?.trim() || null, realmId,
  }, actor)

  const view = (await getCheckView(checkId))!
  return { check: view, recorded: recordResult.recorded, error: recordResult.error }
}

interface QbWriteArgs {
  bankAccountId: string; expenseAccountId: string; vendorId: string
  amountCents: number; docNumber: string; txnDate: string
  memo: string | null; lineDescription: string | null; realmId: string | null
}

/** Perform (or safely re-perform) the QB write for an already-persisted check. Adoption-first so a
 *  retry after a lost commit never creates a duplicate Purchase. */
async function attemptQbWrite(checkId: string, args: QbWriteArgs, actor: Actor): Promise<{ recorded: boolean; error?: string }> {
  const row = await getCheckRow(checkId)
  if (row?.qboTxnId) return { recorded: true } // already recorded — never write twice
  try {
    // Adopt an existing Purchase with this DocNumber if a prior attempt actually reached QB.
    const adopted = await findCheckByDocNumber(args.docNumber)
    const written = adopted ?? await createCheckInQB({
      bankAccountId: args.bankAccountId, expenseAccountId: args.expenseAccountId, vendorId: args.vendorId,
      amountCents: args.amountCents, docNumber: args.docNumber, txnDate: args.txnDate,
      memo: args.memo, lineDescription: args.lineDescription,
    })
    await markRecorded(checkId, { txnId: written.purchaseId, docNumber: written.docNumber, syncToken: written.syncToken, realmId: args.realmId })
    await logCheckEvent(checkId, adopted ? 'recorded_adopted' : 'recorded', actor.name, { purchaseId: written.purchaseId, docNumber: written.docNumber })
    return { recorded: true }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    await markQbFailed(checkId, msg)
    await logCheckEvent(checkId, 'qb_failed', actor.name, { error: msg })
    logger.error(APP, 'qb_write_failed', { checkId, error: msg })
    return { recorded: false, error: msg }
  }
}

/** Retry the QuickBooks write for a previously-failed check (same row, same number, adoption-safe). */
export async function retryQbWrite(checkId: string, actor: Actor): Promise<{ recorded: boolean; error?: string }> {
  const row = await getCheckRow(checkId)
  if (!row) throw new CheckValidationError('Check not found.', 'not_found')
  if (row.qboTxnId) return { recorded: true }
  const cfg = await getCheckConfig()
  const expenseAccountId = cfg.categoryAccounts[row.category] || row.expenseQboAccountId
  let realmId: string | null = row.realmId
  try { realmId = (await getValidAccessToken()).realmId } catch { /* keep prior */ }
  return attemptQbWrite(checkId, {
    bankAccountId: row.bankQboAccountId, expenseAccountId, vendorId: row.payeeQboVendorId!,
    amountCents: row.amountCents, docNumber: String(row.checkNumber), txnDate: String(row.checkDate),
    memo: row.memo, lineDescription: row.memo, realmId,
  }, actor)
}

/**
 * Record the outcome of a print attempt. Refuses to mark a check printed unless it is actually recorded
 * in QuickBooks (a negotiable check must never leave the business without its accounting record).
 */
export async function recordPrintResult(checkId: string, success: boolean, actor: Actor, opts: { reprint?: boolean } = {}): Promise<CheckView> {
  const row = await getCheckRow(checkId)
  if (!row) throw new CheckValidationError('Check not found.', 'not_found')
  if (row.qbStatus !== 'recorded') throw new CheckValidationError('This check is not recorded in QuickBooks yet — resolve the accounting record before printing.', 'not_recorded')
  const updated = await setPrintStatus(checkId, success ? 'printed' : 'print_failed', { bumpReprint: !!opts.reprint && success })
  await logCheckEvent(checkId, opts.reprint ? (success ? 'reprinted' : 'reprint_failed') : (success ? 'printed' : 'print_failed'), actor.name, { reprintCount: updated?.reprintCount })
  const cfg = await getCheckConfig()
  return toView(updated!, cfg.banks[updated!.bankKey as BankKey]?.label ?? updated!.bankKey)
}

/** Guard for the print/reprint route: a check may be (re)printed only once it is recorded in QB. */
export async function assertPrintable(checkId: string): Promise<void> {
  const row = await getCheckRow(checkId)
  if (!row) throw new CheckValidationError('Check not found.', 'not_found')
  if (row.qbStatus !== 'recorded') throw new CheckValidationError('Check is not recorded in QuickBooks yet.', 'not_recorded')
}

/**
 * Enqueue a check onto the cloud print queue for the always-on Pitt Stop print bridge (production path;
 * the manager's phone never talks to the printer directly). A recorded check is required. `reprint` just
 * enqueues another job for the SAME check/number/QBO txn — it never creates or alters any QuickBooks
 * transaction. The job payload is a self-contained snapshot of the positioned fields.
 */
export async function queueCheckPrint(checkId: string, actor: Actor, opts: { reprint?: boolean } = {}): Promise<{ jobId: string }> {
  const row = await getCheckRow(checkId)
  if (!row) throw new CheckValidationError('Check not found.', 'not_found')
  if (row.qbStatus !== 'recorded') throw new CheckValidationError('This check is not recorded in QuickBooks yet — resolve the accounting record before printing.', 'not_recorded')
  const cfg = await getCheckConfig()
  const view = (await getCheckView(checkId))!
  const template = assembleCheckTemplate(cfg, cfg.layout, { test: false, checkNumber: view.checkNumber })
  const payload = buildCheckPayload(view, cfg.layout, template)
  const job = await enqueuePrintJob({ checkId, kind: opts.reprint ? 'reprint' : 'check', payload, createdBy: actor.name })
  await logCheckEvent(checkId, opts.reprint ? 'reprint_queued' : 'print_queued', actor.name, { jobId: job.id })
  return { jobId: job.id }
}

/**
 * Enqueue a NON-NEGOTIABLE VOID test page to the shop printer via the queue — proves the full
 * phone → cloud → bridge → Brother path and is the calibration tool. Creates NO check record and NO
 * QuickBooks transaction; the bridge stamps a VOID watermark and the MICR band is a placeholder.
 */
export async function enqueueTestPrint(actor: Actor): Promise<{ jobId: string }> {
  const cfg = await getCheckConfig()
  const template = assembleCheckTemplate(cfg, cfg.layout, { test: true })
  const fields = buildFields(testValues(), cfg.layout)
  const payload: CheckPrintPayload = {
    pageWidthIn: PAGE_WIDTH_IN, pageHeightIn: PAGE_HEIGHT_IN, fields, template,
    watermark: 'VOID - TEST - NOT NEGOTIABLE',
  }
  const job = await enqueuePrintJob({ checkId: null, kind: 'check', payload, createdBy: actor.name })
  return { jobId: job.id }
}

/**
 * Apply a print bridge's reported outcome for a queued job: mark the job printed/failed AND reflect it on
 * the underlying check (print_status; reprintCount when the job was a reprint), fully audited. Never
 * touches QuickBooks. Idempotent-ish: a result for an already-finished job is a harmless no-op.
 */
export async function applyBridgeResult(jobId: string, success: boolean, error: string | null): Promise<{ ok: true }> {
  const job = await getJob(jobId)
  if (!job) throw new CheckValidationError('Print job not found.', 'job_not_found')
  if (success) await markJobPrinted(jobId)
  else await markJobFailed(jobId, error ?? 'print failed')
  if (job.checkId) {
    // Reflect onto the check (guarded: only a recorded check can be marked printed). A failed reprint must
    // not clobber an earlier successful print_status back to failed if the check was already printed — but
    // recording the attempt via events is always useful, so we only advance print_status on success or when
    // the check is not yet printed.
    const row = await getCheckRow(job.checkId)
    if (row && row.qbStatus === 'recorded') {
      const isReprint = job.kind === 'reprint'
      if (success) await recordPrintResult(job.checkId, true, { key: null, name: 'print-bridge' }, { reprint: isReprint })
      else if (row.printStatus !== 'printed') await recordPrintResult(job.checkId, false, { key: null, name: 'print-bridge' })
      else await logCheckEvent(job.checkId, 'reprint_failed', 'print-bridge', { jobId })
    }
  }
  return { ok: true }
}
