CREATE TABLE IF NOT EXISTS estimate_intakes (
  order_id uuid PRIMARY KEY REFERENCES service_orders(id) ON DELETE CASCADE,
  qb_estimate_id varchar(100) UNIQUE,
  qb_estimate_number varchar(100),
  qb_hash text,
  sent_hash text,
  sent_at timestamptz,
  create_body jsonb,
  locked_at timestamptz
);
