import type { AppManifest } from '@/apps/types'

export const estimatorApp = {
  id: 'estimator',
  name: 'Estimator',
  description: 'AI-powered repair cost estimates',
  version: '0.0.0',
  routes: {
    main:  '/estimator',
    admin: '/admin/estimator',
    api:   '/api/estimator',
  },
  enabled: false,
} satisfies AppManifest
