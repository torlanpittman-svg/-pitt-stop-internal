import { redirect } from 'next/navigation'
import { createVehicleEntry } from '@/apps/vehicle-entry/db'

export const dynamic = 'force-dynamic'

/**
 * Server page — no client JS needed.
 * Opens as a plain link, creates a mock entry, redirects to its confirm page.
 * Tests: server DB write + Next.js redirect, zero JS required on the client.
 */
export default async function TestEntryPage() {
  const id = await createVehicleEntry({
    photoUrl: 'test://nav-link',
    year: '2021',
    make: 'Toyota',
    model: 'Tacoma',
    color: 'White',
    stockNumber: 'PS-TEST',
    ocrConfidence: { year: 0.97, make: 0.95, model: 0.89, color: 0.91, stockNumber: 0.71 },
    rawOcrResponse: { source: 'test-nav-link' },
  })
  redirect(`/vehicle-entry/confirm/${id}`)
}
