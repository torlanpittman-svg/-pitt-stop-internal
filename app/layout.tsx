import type { Metadata, Viewport } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import { ServiceWorkerRegister } from './sw-register'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })

export const metadata: Metadata = {
  title: 'Pitt Stop OS',
  description: 'Pitt Stop employee tools',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Pitt Stop OS',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#030712',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <head>
        {/* iOS home screen icon — replace /icons/apple-touch-icon.png with a real 180x180 PNG */}
        <link rel="apple-touch-icon" href="/icons/icon-512.svg" />
      </head>
      <body className="h-full bg-gray-950 font-[family-name:var(--font-geist)] antialiased">
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  )
}
