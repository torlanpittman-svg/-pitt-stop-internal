'use client'

import Link from 'next/link'

/**
 * Presentational Parts landing — shared by the real `/parts` page and the local preview so the owner reviews
 * the ACTUAL screen. No data fetching, no auth; the caller gates access. Opens the shop's PartsTech in a new
 * tab (no embedding/scraping/stored credentials/guessed VIN deep links); ordering + delivery happen there.
 *
 * In the REAL page no callbacks are passed, so the Work Board / Home links navigate normally via their href
 * defaults (unchanged). The local preview passes `onWorkBoard` / `onHome` to keep the sample flow in-page
 * (prevent default + switch the preview screen) without touching production behavior.
 */
const PARTSTECH_URL = 'https://app.partstech.com/'

export default function PartsLanding({ importEnabled, homeHref = '/', workBoardHref = '/work-board', onWorkBoard, onHome }: {
  importEnabled: boolean; homeHref?: string; workBoardHref?: string; onWorkBoard?: () => void; onHome?: () => void
}) {
  const nav = (cb?: () => void) => (cb ? (e: React.MouseEvent) => { e.preventDefault(); cb() } : undefined)
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <a
          href={PARTSTECH_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-[56px] items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 text-center text-lg font-semibold text-white shadow-lg shadow-blue-900/40 transition-colors hover:bg-blue-500 active:bg-blue-700"
        >
          Open PartsTech
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>
        </a>
        <p className="text-[15px] leading-relaxed text-gray-300">
          Opens PartsTech in a new tab to look up parts in NAPA or O&apos;Reilly. <span className="text-gray-100">Sign in if
          prompted.</span> Build the cart, then at checkout <span className="text-gray-100">choose Delivery and confirm the
          shop delivery address.</span>
        </p>
      </section>

      <section className="rounded-2xl border border-gray-800 bg-gray-900 p-4 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Add parts to a job</h2>
        {importEnabled ? (
          <ol className="space-y-2 text-[15px] leading-relaxed text-gray-300">
            <li><span className="font-semibold text-gray-100">1.</span> Open the job on the Work Board (tap <span className="text-gray-100">Copy VIN</span> there to paste into PartsTech if you need it).</li>
            <li><span className="font-semibold text-gray-100">2.</span> In PartsTech, screenshot the cart / quote / order — the screenshot carries the part numbers and cost.</li>
            <li><span className="font-semibold text-gray-100">3.</span> Back on the job, open <span className="text-gray-100">Parts → Import from screenshot</span> and upload up to 4 screenshots.</li>
            <li><span className="font-semibold text-gray-100">4.</span> Review the parts and prices, then save them to the job.</li>
          </ol>
        ) : (
          <p className="text-[15px] leading-relaxed text-gray-300">
            To track parts against a job, open the job on the Work Board and use its Parts section.
          </p>
        )}
        <Link
          href={workBoardHref}
          onClick={nav(onWorkBoard)}
          className="inline-flex min-h-[48px] items-center rounded-xl border border-gray-700 bg-gray-800 px-4 text-[15px] font-semibold text-gray-100 hover:bg-gray-700"
        >
          Go to the Work Board
        </Link>
      </section>

      <Link href={homeHref} onClick={nav(onHome)} className="inline-flex min-h-[44px] items-center text-sm text-gray-400 hover:text-gray-200">← Back to Home</Link>
    </div>
  )
}
