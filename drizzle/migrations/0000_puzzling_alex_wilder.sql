CREATE TABLE "vehicle_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"photo_url" text NOT NULL,
	"year" varchar(4),
	"make" varchar(100),
	"model" varchar(100),
	"color" varchar(100),
	"custom_color" varchar(100),
	"stock_number" varchar(100),
	"ocr_confidence" jsonb,
	"raw_ocr_response" jsonb,
	"was_corrected" boolean DEFAULT false NOT NULL,
	"status" varchar(50) DEFAULT 'ready_for_quickbooks' NOT NULL,
	"quickbooks_invoice_id" varchar(100)
);
--> statement-breakpoint
CREATE INDEX "entries_status_idx" ON "vehicle_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "entries_created_at_idx" ON "vehicle_entries" USING btree ("created_at");