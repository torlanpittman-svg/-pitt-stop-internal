-- License Plate → VIN lookup: durable cache (reduce provider API calls) + audit
-- columns on the captured job. All additive / nullable; safe to re-run.

-- Cache successful (and recent) plate lookups so repeat scans don't re-bill the
-- provider. One row per (plate, state); refreshed on lookup.
CREATE TABLE IF NOT EXISTS plate_lookup_cache (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate      varchar(16) NOT NULL,
  state      varchar(2)  NOT NULL,
  vin        varchar(17),
  provider   varchar(40) NOT NULL,
  status     varchar(40),
  year       varchar(4),
  make       varchar(100),
  model      varchar(100),
  trim       varchar(120),
  body_class varchar(60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS plate_lookup_cache_key ON plate_lookup_cache (plate, state);

-- Vehicle-identification audit on the captured Quick Entry job.
ALTER TABLE quick_entry_jobs ADD COLUMN IF NOT EXISTS id_method         varchar(20);   -- plate_lookup | vin_camera | vin_upload | vin_manual | vehicle_manual
ALTER TABLE quick_entry_jobs ADD COLUMN IF NOT EXISTS plate             varchar(16);
ALTER TABLE quick_entry_jobs ADD COLUMN IF NOT EXISTS plate_state       varchar(2);
ALTER TABLE quick_entry_jobs ADD COLUMN IF NOT EXISTS raw_ocr_vin       varchar(32);   -- OCR/candidate VIN (may be invalid)
ALTER TABLE quick_entry_jobs ADD COLUMN IF NOT EXISTS final_vin         varchar(17);
ALTER TABLE quick_entry_jobs ADD COLUMN IF NOT EXISTS lookup_provider   varchar(40);
ALTER TABLE quick_entry_jobs ADD COLUMN IF NOT EXISTS lookup_status     varchar(40);
ALTER TABLE quick_entry_jobs ADD COLUMN IF NOT EXISTS lookup_request_id varchar(120);
ALTER TABLE quick_entry_jobs ADD COLUMN IF NOT EXISTS vehicle_edited    boolean NOT NULL DEFAULT false;
