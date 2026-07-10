import type { AppManifest } from '@/apps/types'

export const vehicleEntryApp = {
  id: 'vehicle-entry',
  name: 'Vehicle Entry',
  description: 'Photo scan handwritten key tags',
  version: '1.0.0',
  routes: {
    main:  '/vehicle-entry',
    admin: '/admin/vehicle-entry',
    api:   '/api/vehicle-entry',
  },
  enabled: true,
} satisfies AppManifest
