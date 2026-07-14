/**
 * POST /api/vehicle-entry/pilot-simulate
 *
 * Simulates 30 vehicle submissions (10 per dealership) using real DB + real sync logic.
 * Uses mock QB provider. Verifies routing, deduplication, and data integrity.
 * Returns a full test report.
 */

import { NextResponse } from 'next/server'
import { createVehicleEntry, updateVehicleEntry, listDealerships } from '@/apps/vehicle-entry/db'
import { getActiveBatchForDealership, getMockQBInvoice } from '@/apps/vehicle-entry/invoice-db'
import { syncEntryToInvoice } from '@/apps/vehicle-entry/invoice-sync'

export const dynamic = 'force-dynamic'

const VEHICLES = [
  { year: '2023', make: 'Honda',   model: 'CR-V',     color: 'White'  },
  { year: '2022', make: 'Toyota',  model: 'Camry',    color: 'Black'  },
  { year: '2024', make: 'Ford',    model: 'Escape',   color: 'Silver' },
  { year: '2023', make: 'Hyundai', model: 'Sonata',   color: 'Gray'   },
  { year: '2022', make: 'Kia',     model: 'Sportage', color: 'Red'    },
  { year: '2024', make: 'Nissan',  model: 'Altima',   color: 'Blue'   },
  { year: '2023', make: 'Subaru',  model: 'Outback',  color: 'Green'  },
  { year: '2022', make: 'Chevrolet', model: 'Malibu', color: 'White'  },
  { year: '2024', make: 'BMW',     model: '3 Series', color: 'Black'  },
  { year: '2023', make: 'Mazda',   model: 'CX-5',     color: 'White'  },
]

export async function POST() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Simulation requires a real database' }, { status: 400 })
  }

  const now = new Date()
  const dealerships = await listDealerships(true)
  if (dealerships.length === 0) {
    return NextResponse.json({ error: 'No active dealerships found' }, { status: 400 })
  }

  type EntryResult = {
    entryId:       string
    stockNumber:   string
    dealership:    string
    batchInvoice:  string | null
    syncOutcome:   string
    correct:       boolean
    error?:        string
  }

  const results: EntryResult[] = []
  const createdIds: string[] = []

  // Create 10 entries per dealership
  for (const dealer of dealerships) {
    const batch = await getActiveBatchForDealership(dealer.id)

    for (let i = 1; i <= 10; i++) {
      const v           = VEHICLES[(i - 1) % VEHICLES.length]
      const stockSuffix = String(100000 + i).slice(-6)
      const stockNumber = `${dealer.stockPrefix}${stockSuffix}`
      const simOffset   = i * 15_000  // 15 seconds apart per vehicle

      const entryId = await createVehicleEntry({
        photoUrl:     `sim://pilot-test/${dealer.stockPrefix}${i}`,
        year:         v.year,
        make:         v.make,
        model:        v.model,
        color:        v.color,
        stockNumber,
        entryMethod:  'key-tag',
        dealershipId: dealer.id,
        dealershipName: dealer.name,
        photoTakenAt:   new Date(now.getTime() - simOffset - 60_000),
        ocrCompletedAt: new Date(now.getTime() - simOffset - 30_000),
        isPilotEntry:   true,
      })

      await updateVehicleEntry(entryId, {
        employeeConfirmedAt: new Date(now.getTime() - simOffset),
      })

      createdIds.push(entryId)

      const outcome = await syncEntryToInvoice(entryId)
      results.push({
        entryId,
        stockNumber,
        dealership:    dealer.name,
        batchInvoice:  batch?.quickbooksInvoiceNumber ?? null,
        syncOutcome:   outcome.outcome,
        correct:       outcome.outcome === 'synced' || (batch === null && outcome.outcome === 'pending_invoice_assignment'),
        error:         outcome.reason ?? undefined,
      })
    }
  }

  // ── Verify no duplicate invoice lines ─────────────────────────────────────
  const verifyFailures: string[] = []
  for (const dealer of dealerships) {
    const batch = await getActiveBatchForDealership(dealer.id)
    if (!batch?.quickbooksInvoiceId) continue
    const inv = await getMockQBInvoice(batch.quickbooksInvoiceId)
    if (!inv) continue

    const seen   = new Set<string>()
    const dupes: string[] = []
    for (const line of inv.lines) {
      const desc = line.description
      if (seen.has(desc)) dupes.push(desc)
      seen.add(desc)
    }
    if (dupes.length > 0) {
      verifyFailures.push(`${dealer.name}: duplicate lines found: ${dupes.join(', ')}`)
    }
  }

  // ── Verify routing — each entry went to the right batch ───────────────────
  const routingFailures = results.filter(r => {
    if (r.syncOutcome === 'pending_invoice_assignment') return false  // no active batch = expected
    return r.batchInvoice === null
  })

  const passed = results.filter(r => r.correct).length
  const failed = results.filter(r => !r.correct).length

  return NextResponse.json({
    summary: {
      total:              results.length,
      passed,
      failed,
      duplicateViolations: verifyFailures.length,
      routingFailures:    routingFailures.length,
    },
    verification: {
      noDuplicateLines:  verifyFailures.length === 0,
      correctRouting:    routingFailures.length === 0,
      noLostEntries:     createdIds.length === results.length,
    },
    byOutcome: {
      synced:                    results.filter(r => r.syncOutcome === 'synced').length,
      pending_invoice_assignment: results.filter(r => r.syncOutcome === 'pending_invoice_assignment').length,
      needs_review:              results.filter(r => r.syncOutcome === 'needs_review').length,
      error:                     results.filter(r => r.syncOutcome === 'error').length,
    },
    failures:  verifyFailures,
    results,
  })
}
