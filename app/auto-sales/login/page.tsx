/** Employee PIN login for the Auto Sales surface. Exempt from the employee gate (proxy.ts) so a device
 *  can sign in. If no PIN is configured, employees don't need this — send them straight in. */
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { employeePinConfigured } from '@/apps/auto-sales/session'
import PinPad from './PinPad'

export const dynamic = 'force-dynamic'

export default function AutoSalesLoginPage() {
  if (!employeePinConfigured()) redirect('/auto-sales')
  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 max-w-xl mx-auto px-4 py-10 flex flex-col items-center">
      <h1 className="text-xl font-bold text-white">Auto Sales</h1>
      <p className="text-gray-500 text-sm mt-1 mb-4">Enter the shop PIN</p>
      <Suspense><PinPad /></Suspense>
    </main>
  )
}
