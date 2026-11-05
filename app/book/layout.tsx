/**
 * Public booking pages (/book, /book/a/<token>, /book/r/<token>) — styled to match
 * pittstopdetailandautosales.com: Roboto, Courgette script headline, navy bar, red gradient pill buttons.
 * Overrides the staff app's viewport so customers can pinch-zoom.
 */
import type { Viewport } from 'next'
import Script from 'next/script'
import { Courgette, Roboto } from 'next/font/google'
import './book.css'

/** Google tag (GA4 and/or Google Ads) for the "Booking confirmed" measurement — see ./conversion.ts. Unset = not loaded. */
const TAG_IDS = [process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID, process.env.NEXT_PUBLIC_GOOGLE_ADS_ID].map((v) => (v || '').trim()).filter(Boolean)

const roboto = Roboto({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-ps-body', display: 'swap' })
const courgette = Courgette({ subsets: ['latin'], weight: '400', variable: '--font-ps-script', display: 'swap' })

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0d4469', colorScheme: 'light' }

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`ps-book ${roboto.variable} ${courgette.variable}`}>
      {TAG_IDS.length > 0 && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(TAG_IDS[0])}`} strategy="afterInteractive" />
          <Script id="ps-gtag-init" strategy="afterInteractive">{`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());${TAG_IDS.map((id) => `gtag('config',${JSON.stringify(id)});`).join('')}`}</Script>
        </>
      )}
      {children}
    </div>
  )
}
