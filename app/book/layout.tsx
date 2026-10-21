/**
 * Public booking pages (/book, /book/a/<token>, /book/r/<token>) — styled to match
 * pittstopdetailandautosales.com: Roboto, Courgette script headline, navy bar, red gradient pill buttons.
 * Overrides the staff app's viewport so customers can pinch-zoom.
 */
import type { Viewport } from 'next'
import { Courgette, Roboto } from 'next/font/google'
import './book.css'

const roboto = Roboto({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-ps-body', display: 'swap' })
const courgette = Courgette({ subsets: ['latin'], weight: '400', variable: '--font-ps-script', display: 'swap' })

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0d4469', colorScheme: 'light' }

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return <div className={`ps-book ${roboto.variable} ${courgette.variable}`}>{children}</div>
}
