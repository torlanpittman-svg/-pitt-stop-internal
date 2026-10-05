-- Vehicle documentation stays on the same order through estimate conversion and invoicing.
CREATE TABLE IF NOT EXISTS order_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_order_id uuid NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  image_hash text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  resized boolean NOT NULL DEFAULT false,
  caption text NOT NULL DEFAULT '',
  included boolean NOT NULL DEFAULT true,
  uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX IF NOT EXISTS order_photos_order_idx ON order_photos(service_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_photos_order_hash_idx ON order_photos(service_order_id, image_hash);
