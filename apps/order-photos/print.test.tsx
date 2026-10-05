import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import PhotoPrintSheets from '@/app/components/PhotoPrintSheets'
import type { OrderPhoto } from './types'

it('prints only selected photos with vehicle, order, invoice references and escaped notes', () => {
  const photos: OrderPhoto[] = [
    { id: 'one', included: true, caption: '<script>bad()</script>', filename: 'door.jpg', createdAt: '2026-10-05T14:00:00Z', imageUrl: '/one', downloadUrl: '/one?download=1', resized: false },
    { id: 'two', included: false, caption: 'Internal only', filename: 'other.jpg', createdAt: '2026-10-05T14:00:00Z', imageUrl: '/two', downloadUrl: '/two?download=1', resized: false },
  ]
  const html = renderToStaticMarkup(<PhotoPrintSheets photos={photos} details={{ customer: 'Customer', vehicle: '2020 Honda Civic', vin: 'VIN123', orderNumber: 'SO-123', invoiceNumber: 'INV-55', estimateNumber: 'EST-44' }} />)
  expect(html).toContain('2020 Honda Civic')
  expect(html).toContain('VIN123')
  expect(html).toContain('SO-123')
  expect(html).toContain('INV-55')
  expect(html).toContain('EST-44')
  expect(html).toContain('Photo 1 of 1')
  expect(html).not.toContain('Internal only')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
})
