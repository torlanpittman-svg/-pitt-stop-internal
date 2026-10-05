import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { serviceOrders } from '@/apps/workflow/schema'

// Attached to the order, so estimate → job → invoice needs no copying/relinking.
export const orderPhotos = pgTable('order_photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  serviceOrderId: uuid('service_order_id').notNull().references(() => serviceOrders.id, { onDelete: 'cascade' }),
  storagePath: text('storage_path').notNull(),
  imageHash: text('image_hash').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  resized: boolean('resized').notNull().default(false),
  caption: text('caption').notNull().default(''),
  included: boolean('included').notNull().default(true),
  uploadedBy: text('uploaded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => [
  index('order_photos_order_idx').on(t.serviceOrderId),
  uniqueIndex('order_photos_order_hash_idx').on(t.serviceOrderId, t.imageHash),
])
