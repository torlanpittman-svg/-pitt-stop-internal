# Changelog

All notable changes to Pitt Stop OS. Newest first. Dates are absolute.
See `docs/ROADMAP.md` for the living project plan.

## [Unreleased]

### Added — Dealer Check-In (Module 4)
- **Scheduled queue drain** (2026-07-29): `GET /api/cron/drain-dealer-queue`
  (guarded by `CRON_SECRET`) + `vercel.json` daily cron auto-retries queued
  invoices. Sub-daily frequency needs Vercel Pro (owner decision).
- **Check-in metrics dashboard** (2026-07-29): `getCheckInMetrics` +
  `GET /api/dealer-checkin/metrics` + admin page `/admin/dealer-checkin`
  (throughput, avg scan time, avg QB latency, duplicate rate, queue depth) with a
  Drain-queue control. Aggregation math validated.
- **Offline QB queue + retry** (2026-07-29): if QuickBooks is unavailable at
  check-in, the Work Board order is still created and the invoice is queued
  (`qb_sync_status = 'queued'`); `POST /api/dealer-checkin/retry-queue` drains the
  queue and completes writes (idempotent — skips a stock already on the open
  invoice). `GET` returns queue depth. Validated end-to-end on sandbox.
- **Instrumentation**: `dealer_scans.scan_duration_ms` + `qb_latency_ms` captured
  per check-in (migration 0004).
- **Dealer Check-In UI** (2026-07-28): camera-first `/dealer-check-in` — live VIN
  barcode scan + single-frame tag OCR (stock/color), NHTSA decode, one confirmation
  screen (dealer/vehicle/color/stock + invoice line + rate), inline $125 toggle,
  duplicate warning + Check-In-Anyway, low-confidence retake, one-tap "Looks Good"
  → Work Board redirect. Gloves/sunlight design. `app/api/dealer-checkin/ocr`.
- **API routes**: `POST /api/dealer-checkin/preview` (read-only dry run) and
  `POST /api/dealer-checkin` (confirm) with a production-write guard
  (`X-QB-Write-Approved` required on the production QB env).
- **Orchestration service** (`apps/dealer-checkin/service.ts`):
  `previewDealerCheckIn` + `checkInDealerVehicle` — dealer resolve → pricing gate
  → duplicate check → live append-vs-create QB write → Work Board order → audit
  trail. Validated by a sandbox self-test (9/9 paths, auto-cleanup).
- **QB invoice write** (`apps/quickbooks/invoice-write.ts`): ensure item/account
  (Complete Detail / Detail Sales), create/append invoice, Due-on-receipt terms.
- **QB accounting helpers**: `queryQBO`, customers (`ensureCustomer`), invoices
  (`findAppendableInvoice` — open + not-sent).
- **Dealer mapping**: `dealerships.qb_customer_id/qb_customer_name/billing_email/
  tax_exempt/rate_default`; `POST /api/quickbooks/setup-dealers` (idempotent).
- **Business-rule engine** (`apps/dealer-checkin/rules.ts`) with 20 vitest unit
  tests: pricing ($200/$125, prompt on T-prefix or white tag, never auto-$125),
  stock prefix, line format, appendable-invoice selection, duplicate detection.
- **Schema**: `dealer_scans` + `dealer_scan_events` (migrations 0003–0004).

### Added — QuickBooks integration (Module 4 · Phase 0)
- Real Intuit **OAuth 2.0** with AES-256-GCM encrypted tokens, transparent
  auto-refresh (5-min window, rotation), `qb_connections` table (migration 0001),
  admin UI at `/admin/integrations/quickbooks`, routes
  `/api/auth/quickbooks/{connect,callback,status,test,disconnect}`.
- Running on the QuickBooks **sandbox** for pipeline development (dev keys);
  production go-live is gated on Intuit production keys + https redirect + owner
  approval.

### Fixed
- Self-test VINs exceeded `varchar(17)` — 17-char generator (caught by validation).
- Dev server bound IPv6-only — start with `-H 0.0.0.0` so the browser reaches it.
- OAuth state mismatch from mixing `127.0.0.1` and `localhost` — use `localhost`.

### Tooling
- `vitest` test runner (`npm test`).
- Idempotent migration runner `scripts/apply-qb-migration.mjs <file>`.
- Read-only QB diagnostics: `scripts/qb-{diagnose,query-customers,verify-refresh}.mjs`.
