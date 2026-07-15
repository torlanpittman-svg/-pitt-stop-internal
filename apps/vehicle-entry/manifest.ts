import type { AppManifest } from '@/apps/types'

export const vehicleEntryApp = {
  id: 'vehicle-entry',
  name: 'Dealer Vehicle Entry',
  description: 'Scan a dealership key tag and add the vehicle.',
  buttonText: 'Scan Dealer Key Tag',
  version: '1.0.0',
  routes: {
    main:  '/vehicle-entry',
    admin: '/admin/vehicle-entry',
    api:   '/api/vehicle-entry',
  },
  enabled: true,
} satisfies AppManifest
