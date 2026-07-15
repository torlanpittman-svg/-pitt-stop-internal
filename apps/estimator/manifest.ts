import type { AppManifest } from '@/apps/types'

export const estimatorApp = {
  id: 'estimator',
  name: 'Retail Estimator',
  description: 'Photograph a vehicle and create an estimate.',
  buttonText: 'Create Retail Estimate',
  version: '0.0.0',
  routes: {
    main:  '/estimator',
    admin: '/admin/estimator',
    api:   '/api/estimator',
  },
  enabled: true,
} satisfies AppManifest
