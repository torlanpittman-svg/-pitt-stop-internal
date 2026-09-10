/**
 * Physical check-number integrity.
 *
 * The number printed on the paper IS the QuickBooks DocNumber IS our record — one sequence per bank.
 * Numbers are reserved with a single atomic `UPDATE … RETURNING` on the check_sequence row, so two
 * managers issuing checks at the same moment can NEVER receive the same number (the row lock serializes
 * them). The system never invents a starting number: the row exists only after the owner initializes it
 * (initCheckSequence) with the number of the next blank check in the tray.
 */
import { getDb } from '@/platform/db'
import { and, eq, sql } from 'drizzle-orm'
import { checkSequence } from './schema'
import type { BankKey } from './types'

export class SequenceNotInitializedError extends Error {
  constructor(public bankKey: BankKey) {
    super(`Check sequence for "${bankKey}" is not initialized. Set the starting check number before writing checks.`)
    this.name = 'SequenceNotInitializedError'
  }
}

/** Current next number without consuming it (null if not initialized). */
export async function peekNextNumber(bankKey: BankKey): Promise<number | null> {
  const [row] = await getDb().select().from(checkSequence).where(eq(checkSequence.bankKey, bankKey)).limit(1)
  return row?.nextNumber ?? null
}

/**
 * Atomically reserve the next check number for a bank and advance the sequence. Returns the reserved
 * number. Throws SequenceNotInitializedError if the owner has not set a start yet. Single statement ⇒
 * concurrency-safe (no read-then-write gap).
 */
export async function reserveNextNumber(bankKey: BankKey): Promise<number> {
  const [row] = await getDb()
    .update(checkSequence)
    .set({ nextNumber: sql`${checkSequence.nextNumber} + 1`, updatedAt: new Date() })
    .where(eq(checkSequence.bankKey, bankKey))
    .returning({ reserved: sql<number>`${checkSequence.nextNumber} - 1` })
  if (!row) throw new SequenceNotInitializedError(bankKey)
  return Number(row.reserved)
}

/**
 * Initialize (or reset) a bank's starting check number to `startNumber` — the number on the NEXT blank
 * check. Owner-only setup. Refuses to LOWER an existing sequence unless force=true (guards against
 * accidentally reusing already-issued numbers).
 */
export async function initCheckSequence(bankKey: BankKey, startNumber: number, actor: string | null, force = false): Promise<{ nextNumber: number }> {
  if (!Number.isInteger(startNumber) || startNumber <= 0) throw new Error('startNumber must be a positive integer')
  const db = getDb()
  const [existing] = await db.select().from(checkSequence).where(eq(checkSequence.bankKey, bankKey)).limit(1)
  if (existing) {
    if (!force && startNumber < existing.nextNumber) {
      throw new Error(`Refusing to lower the check sequence from ${existing.nextNumber} to ${startNumber} (would risk reusing issued numbers). Pass force to override.`)
    }
    await db.update(checkSequence).set({ nextNumber: startNumber, updatedBy: actor, updatedAt: new Date() }).where(eq(checkSequence.bankKey, bankKey))
  } else {
    await db.insert(checkSequence).values({ bankKey, nextNumber: startNumber, updatedBy: actor })
  }
  return { nextNumber: startNumber }
}

/**
 * Release a reserved number back to the sequence ONLY when it is still the most-recently issued one and
 * nothing consumed it after — used when a QuickBooks write fails before any check record is committed, so
 * we don't burn a physical number. Safe no-op if another number was issued in between (never rewinds over
 * a live check). Best-effort; callers must not depend on it for correctness.
 */
export async function releaseIfLast(bankKey: BankKey, reserved: number): Promise<boolean> {
  const [row] = await getDb()
    .update(checkSequence)
    .set({ nextNumber: reserved, updatedAt: new Date() })
    .where(and(eq(checkSequence.bankKey, bankKey), eq(checkSequence.nextNumber, reserved + 1)))
    .returning({ nextNumber: checkSequence.nextNumber })
  return !!row
}
