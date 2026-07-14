import { NextResponse } from 'next/server'
import { listVehicleEntries } from '@/apps/vehicle-entry/db'
import { listInvoiceBatches } from '@/apps/vehicle-entry/invoice-db'

export const dynamic = 'force-dynamic'

function fmtTime(d: Date | string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

export async function GET() {
  try {
    return await getStats()
  } catch (err) {
    console.error('[pilot-stats] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

async function getStats() {
  const [all, batches] = await Promise.all([
    listVehicleEntries(500),
    listInvoiceBatches(),
  ])

  const pilot = all
    .filter(e => e.isPilotEntry)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  // ── Today's Vehicles ────────────────────────────────────────────────────
  const total            = pilot.length
  const synced           = pilot.filter(e => e.invoiceSyncStatus === 'synced').length
  const waitingForReview = pilot.filter(e =>
    e.invoiceSyncStatus === 'pending_invoice_assignment' ||
    e.invoiceSyncStatus === 'duplicate_skipped'
  ).length
  const failed = pilot.filter(e => e.invoiceSyncStatus === 'error').length

  // ── OCR ─────────────────────────────────────────────────────────────────
  // Vehicle info: entries with all 5 fields extracted without correction
  const cleanOcrCount = pilot.filter(
    e => !e.wasCorrected && e.year && e.make && e.model && e.color && e.stockNumber
  ).length
  const vehicleInfoAccuracyPct = total > 0 ? Math.round((cleanOcrCount / total) * 100) : null

  // Stock number: compare AI prediction to final value (key-tag entries only)
  const keyTagPilot = pilot.filter(e => e.entryMethod !== 'vin-fallback')
  const stockAccurateCount = keyTagPilot.filter(
    e => e.stockNumber &&
         e.stockNumberAiPrediction &&
         e.stockNumber.toUpperCase() === e.stockNumberAiPrediction.toUpperCase()
  ).length
  const stockAccuracyPct = keyTagPilot.length > 0
    ? Math.round((stockAccurateCount / keyTagPilot.length) * 100)
    : null

  const vinFallbacks = pilot.filter(e => e.entryMethod === 'vin-fallback').length

  // ── Employee ─────────────────────────────────────────────────────────────
  const timed    = pilot.filter(e => e.photoTakenAt && e.employeeConfirmedAt)
  const scanTimes = timed.map(
    e => new Date(e.employeeConfirmedAt!).getTime() - new Date(e.photoTakenAt!).getTime()
  )
  const avgScanMs = scanTimes.length > 0
    ? Math.round(scanTimes.reduce((a, b) => a + b, 0) / scanTimes.length)
    : null

  const corrections           = pilot.filter(e => e.wasCorrected).length
  const correctionsPerVehicle = total > 0 ? corrections / total : null

  const firstScanAt = pilot.length > 0 ? fmtTime(pilot[0].photoTakenAt ?? pilot[0].createdAt) : null
  const lastScanAt  = pilot.length > 0 ? fmtTime(pilot[pilot.length - 1].photoTakenAt ?? pilot[pilot.length - 1].createdAt) : null

  // ── Invoice — per dealership batch ───────────────────────────────────────
  const activeBatches = batches.filter(b => b.pittStopStatus === 'active')
  const invoiceSections = activeBatches.map(b => {
    const dealerEntries     = pilot.filter(e => {
      if (e.dealershipName === b.dealershipName) return true
      if (e.dealershipId   === b.dealershipId)   return true
      return false
    })
    const syncedForBatch = dealerEntries.filter(e => e.invoiceSyncStatus === 'synced').length
    const pendingForBatch = dealerEntries.filter(e =>
      e.invoiceSyncStatus === 'pending_invoice_assignment' || e.invoiceSyncStatus === 'duplicate_skipped'
    ).length
    const failedForBatch = dealerEntries.filter(e => e.invoiceSyncStatus === 'error').length

    return {
      dealershipName:  b.dealershipName,
      invoiceNumber:   b.quickbooksInvoiceNumber,
      total:           dealerEntries.length,
      synced:          syncedForBatch,
      waiting:         pendingForBatch,
      failed:          failedForBatch,
    }
  })

  // ── Speed progression (chronological, for the timeline) ─────────────────
  const speedProgression = pilot.map((e, i) => {
    const scanMs = (e.photoTakenAt && e.employeeConfirmedAt)
      ? new Date(e.employeeConfirmedAt).getTime() - new Date(e.photoTakenAt).getTime()
      : null
    const gapMs = (i > 0 && pilot[i - 1].employeeConfirmedAt && e.photoTakenAt)
      ? new Date(e.photoTakenAt).getTime() - new Date(pilot[i - 1].employeeConfirmedAt!).getTime()
      : null
    return {
      n:                 i + 1,
      vehicle:           [e.year, e.make, e.model].filter(Boolean).join(' ') || '—',
      stockNumber:       e.stockNumber ?? '—',
      dealershipName:    e.dealershipName ?? '—',
      invoiceSyncStatus: e.invoiceSyncStatus,
      wasCorrected:      e.wasCorrected,
      entryMethod:       e.entryMethod,
      scanMs,
      gapMs,
      scanTimeAt:        fmtTime(e.photoTakenAt ?? e.createdAt),
    }
  })

  // ── Items needing attention ───────────────────────────────────────────────
  const needsAttention = pilot
    .filter(e =>
      e.invoiceSyncStatus === 'pending_invoice_assignment' ||
      e.invoiceSyncStatus === 'error' ||
      e.invoiceSyncStatus === 'duplicate_skipped'
    )
    .map((e, _, arr) => ({
      n:           pilot.indexOf(e) + 1,
      stockNumber: e.stockNumber ?? '—',
      dealership:  e.dealershipName ?? '—',
      syncStatus:  e.invoiceSyncStatus,
      reason:      e.invoiceSyncError ??
        (e.invoiceSyncStatus === 'duplicate_skipped' ? 'Possible duplicate — check before adding' :
         e.invoiceSyncStatus === 'pending_invoice_assignment' ? 'No active batch found for this dealership' :
         'Unknown error'),
    }))

  return NextResponse.json({
    total,
    synced,
    waitingForReview,
    failed,
    vehicleInfoAccuracyPct,
    stockAccuracyPct,
    vinFallbacks,
    avgScanMs,
    firstScanAt,
    lastScanAt,
    correctionsPerVehicle,
    corrections,
    invoiceSections,
    speedProgression,
    needsAttention,
  })
}
