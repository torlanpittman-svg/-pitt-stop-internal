/**
 * Shared chrome for the public booking pages, mirroring the website: navy contact bar, white header with the
 * Pitt Stop logo, and a short photo band with the script headline. Server-component safe.
 */
import type { ReactNode } from 'react'

export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`

export function BookShell({ phone, address, heading, children, hero = true }: {
  phone: string; address: string; heading: string; children: ReactNode; hero?: boolean
}) {
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to booking</a>
      <div className="bg-[var(--ps-navy-bar)] text-white">
        <div className="mx-auto flex max-w-3xl items-center justify-center gap-3 px-4 py-2 text-sm">
          <a href={telHref(phone)} className="font-medium underline-offset-2 hover:underline">{phone}</a>
          <span aria-hidden className="opacity-60">|</span>
          <span className="truncate opacity-90">College Station, TX</span>
        </div>
      </div>
      <header className="border-b-[3px] border-[var(--ps-red)] bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <a href="https://www.pittstopdetailandautosales.com/" className="shrink-0" aria-label="Pitt Stop Detail & Auto Sales home">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset, also used by the booking-only host */}
            <img src="/book/pittstop-logo.png" width={152} height={48} alt="Pitt Stop Detail & Auto Sales" className="h-12 w-auto" />
          </a>
          <a href={telHref(phone)} className="ps-btn-call !min-h-11 !px-4 text-sm">Call us</a>
        </div>
      </header>
      {hero ? (
        <div className="relative isolate overflow-hidden bg-[var(--ps-ink)]">
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative photo from the website */}
          <img src="/book/shop-banner.webp" alt="" aria-hidden width={1903} height={906} fetchPriority="high"
            className="absolute inset-0 -z-10 h-full w-full object-cover object-[50%_35%] opacity-55" />
          <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[rgba(2,20,36,.85)] via-[rgba(2,20,36,.55)] to-transparent" />
          <div className="mx-auto max-w-3xl px-4 py-6 sm:py-9">
            <p translate="no" className="text-sm font-medium text-[var(--ps-yellow)]">Pitt Stop Detail &amp; Auto Sales</p>
            <h1 className="ps-script mt-1 text-[2rem] leading-tight text-white sm:text-[2.6rem]">{heading}</h1>
          </div>
        </div>
      ) : null}
      <main id="main" className="mx-auto max-w-3xl px-4 pb-16 pt-5 sm:pt-7">{children}</main>
      <footer className="border-t border-[var(--ps-line)] bg-white">
        <div className="mx-auto max-w-3xl px-4 py-5 text-sm text-[var(--ps-body)]">
          <p className="font-medium text-[var(--ps-ink)]">Pitt Stop Detail &amp; Auto Sales</p>
          <p>{address}</p>
          <p><a href={telHref(phone)} className="text-[var(--ps-navy)] underline underline-offset-2">{phone}</a></p>
          <p className="mt-2"><a href="/privacy" className="underline underline-offset-2">Privacy</a> <span aria-hidden>·</span> <a href="/terms" className="underline underline-offset-2">Terms</a></p>
        </div>
      </footer>
    </>
  )
}
