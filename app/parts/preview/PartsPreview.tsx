'use client'

/**
 * LOCAL preview harness (non-production). A simple SCREEN SELECTOR renders ONE real component at a time, each
 * clearly marked SAMPLE, driven by an in-memory fixture transport (no network/DB/AI). Nav (Work Board / Home)
 * is injected to stay inside the sample. The manager job offers each lifecycle scenario; the original source
 * PNGs are shown via the dev-only sample route so extracted rows can be compared to the image.
 */
import { useMemo, useState } from 'react'
import PartImportPanel from '@/app/orders/[id]/PartImportPanel'
import PartsLanding from '@/app/parts/PartsLanding'
import { makeFixtureTransport, PREVIEW_JOB, type Scenario } from '@/scripts/parts-preview/fixtures'

type Screen = 'landing' | 'employee' | 'manager'
const SCENARIOS: Array<{ key: Scenario; label: string }> = [
  { key: 'order', label: 'Placed order' },
  { key: 'quote', label: 'Quote (no cost)' },
  { key: 'failed', label: 'Failed read' },
  { key: 'reading', label: 'Reading…' },
  { key: 'cancelled', label: 'Cancelled' },
]

function ManagerJob({ scenario }: { scenario: Scenario }) {
  const transport = useMemo(() => makeFixtureTransport(true, scenario), [scenario])
  return <PartImportPanel key={scenario} orderId={PREVIEW_JOB.orderId} transport={transport} />
}
function EmployeeJob() {
  const transport = useMemo(() => makeFixtureTransport(false, 'order'), [])
  return <PartImportPanel orderId={PREVIEW_JOB.orderId} transport={transport} />
}

const tabCls = (active: boolean) => `min-h-[44px] rounded-xl px-3 text-sm font-semibold ${active ? 'bg-blue-600 text-white' : 'border border-gray-700 bg-gray-800 text-gray-100'}`

export default function PartsPreview() {
  const [screen, setScreen] = useState<Screen>('landing')
  const [scenario, setScenario] = useState<Scenario>('order')
  return (
    <main className="min-h-screen bg-gray-950 px-4 py-6">
      <div className="mx-auto max-w-md space-y-4">
        <div className="rounded-xl border border-amber-700/50 bg-amber-900/20 p-3 text-sm text-amber-200">
          <strong>SAMPLE PREVIEW — synthetic data.</strong> No real job, PartsTech, AI, or database. Live AI
          extraction is not exercised. Job: {PREVIEW_JOB.orderNumber}.
        </div>

        <nav aria-label="Preview screen" className="flex flex-wrap gap-2">
          <button type="button" className={tabCls(screen === 'landing')} onClick={() => setScreen('landing')}>Parts page</button>
          <button type="button" className={tabCls(screen === 'employee')} onClick={() => setScreen('employee')}>Employee job</button>
          <button type="button" className={tabCls(screen === 'manager')} onClick={() => setScreen('manager')}>Manager job</button>
        </nav>

        {screen === 'landing' && <PartsLanding importEnabled onWorkBoard={() => setScreen('employee')} onHome={() => setScreen('landing')} />}

        {screen === 'employee' && (
          <section>
            <p className="mb-2 text-[13px] leading-relaxed text-gray-400">Employees upload and see a non-money proposal + “Saved — manager review needed” — never costs or the original screenshots.</p>
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-2"><EmployeeJob /></div>
          </section>
        )}

        {screen === 'manager' && (
          <section className="space-y-3">
            <nav aria-label="Scenario" className="flex flex-wrap gap-2">
              {SCENARIOS.map((s) => <button key={s.key} type="button" className={tabCls(scenario === s.key)} onClick={() => setScenario(s.key)}>{s.label}</button>)}
            </nav>
            <p className="text-[13px] leading-relaxed text-gray-400">
              {scenario === 'order' && 'Review prices, link “Brake pad set” to the existing part, toggle “I placed this order”, then Save parts to job.'}
              {scenario === 'quote' && 'A quote with no order #; unit cost is unknown (blank, not $0) and “already placed” stays disabled.'}
              {scenario === 'failed' && 'Screenshots saved but not read — recoverable; Re-read or enter parts manually.'}
              {scenario === 'reading' && 'A read in progress — tap “Check status / retry read” to resolve a stuck read.'}
              {scenario === 'cancelled' && 'A terminal, read-only import.'}
            </p>
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-2"><ManagerJob scenario={scenario} /></div>
          </section>
        )}
      </div>
    </main>
  )
}
