-- 0043_customer_links.sql
-- Additive, non-destructive. Connects a service order to the canonical customer
-- directory (apps/directory/schema.ts `customers`) GOING FORWARD. Historical rows stay
-- NULL and are matched for the customer profile by owned vehicle or exact phone/email at
-- read time (never by name alone). No existing data is rewritten.
--
-- The FK lives only in SQL (not in the Drizzle table definition) to avoid a circular
-- import between apps/workflow/schema.ts and apps/directory/schema.ts. ON DELETE SET NULL
-- so removing a directory customer never deletes work history.

ALTER TABLE service_orders
  ADD COLUMN IF NOT EXISTS customer_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'service_orders_customer_id_fk'
  ) THEN
    ALTER TABLE service_orders
      ADD CONSTRAINT service_orders_customer_id_fk
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS service_orders_customer_idx ON service_orders (customer_id);
