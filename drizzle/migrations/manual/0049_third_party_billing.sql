-- 0049_third_party_billing.sql
-- Additive, non-destructive. Occasional third-party billing: a work order can name a DIFFERENT
-- billing customer + invoice recipient + job contact, WITHOUT changing who owns the vehicle or
-- whose service history this is (service_orders.customer_id / customer_vehicles stay as-is).
--
-- All three columns are NULLable and default NULL → ordinary retail jobs are completely unchanged
-- (NULL means "bill the service customer, as today"). No existing data is rewritten.
--
-- billing_customer_id FK lives only in SQL (not in the Drizzle table definition) to avoid a
-- circular import between apps/workflow/schema.ts and apps/directory/schema.ts — same pattern as
-- customer_id (0043). ON DELETE SET NULL so removing a directory customer never deletes work history.

ALTER TABLE service_orders
  ADD COLUMN IF NOT EXISTS billing_customer_id uuid,
  ADD COLUMN IF NOT EXISTS invoice_recipient_email varchar(240),
  ADD COLUMN IF NOT EXISTS job_contact_name varchar(200);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'service_orders_billing_customer_id_fk'
  ) THEN
    ALTER TABLE service_orders
      ADD CONSTRAINT service_orders_billing_customer_id_fk
      FOREIGN KEY (billing_customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS service_orders_billing_customer_idx ON service_orders (billing_customer_id);
