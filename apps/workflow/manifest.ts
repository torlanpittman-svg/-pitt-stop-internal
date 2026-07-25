import type { AppManifest } from '@/apps/types'

export const workflowApp: AppManifest = {
  id:          'workflow',
  name:        'Work Board',
  description: 'Live shop floor — check in vehicles, track status, assign techs',
  buttonText:  'Open Work Board',
  version:     '1.0.0',
  routes: {
    main:  '/work-board',
    admin: '/admin/workflow',
    api:   '/api/workflow',
  },
  enabled: true,
}
