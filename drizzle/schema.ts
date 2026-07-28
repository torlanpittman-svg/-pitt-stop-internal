/**
 * Platform DB schema aggregator.
 *
 * Re-exports tables from every app's schema.ts.
 * Drizzle Kit reads this file to generate and run migrations.
 *
 * To add a new app's tables:
 *   1. Define tables in  apps/<name>/schema.ts
 *   2. Add one line here: export * from '@/apps/<name>/schema'
 */

export * from '@/apps/vehicle-entry/schema'

// Future app schemas — uncomment as apps are built:
export * from '@/apps/estimator/schema'
export * from '@/apps/ai-learning/schema'
export * from '@/apps/workflow/schema'
export * from '@/apps/quickbooks/schema'
// export * from '@/apps/sop-handbook/schema'
// export * from '@/apps/quality-control/schema'
// export * from '@/apps/inventory/schema'
// export * from '@/apps/customer-intake/schema'
