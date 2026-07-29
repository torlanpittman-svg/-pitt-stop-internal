# Pitt Stop OS Roadmap

> Living source of truth. Updated after every meaningful milestone.
> Last updated: 2026-07-29

## Vision
Build an AI operating system that can eventually run an entire service business with
minimal human involvement, starting with Pitt Stop. Every module replaces a human
workflow — not just digitizes it. The north star: a new employee completes any core
task with almost no training, and the labor that used to require a person (data entry,
invoicing, dispatch, follow-up, reconciliation) is done by the system.

---

# Current Phase

**Phase 3 — Dealer Check-In (hardening)**

Status: 🟢 Near complete

Completion: ~98% (engine, API, camera UI, offline queue, metrics, scheduled drain done)

Expected remaining work:
- On-device validation of camera/barcode on a real phone (headless can't test)
- Auto Work Board sync polish (every completed check-in appears instantly)
- Then: production go-live prep (owner-gated)

---

# Completed

✅ **QuickBooks OAuth 2.0** — 2026-07-28
- Real Intuit OAuth (PKCE-less confidential flow), encrypted tokens (AES-256-GCM),
  transparent auto-refresh (5-min window, rotation), connection status + admin UI.
- Files: `apps/quickbooks/{crypto,config,oauth,db,connection,client,errors,schema}.ts`,
  `app/api/auth/quickbooks/{connect,callback,status,test,disconnect}`,
  `app/admin/integrations/quickbooks/*`, migration 0001.
- Tests/validation: auto-refresh verified (forced expiry → rotate → persist),
  survives server restart; encryption round-trip + tamper rejection.
- Commits: 6342cc5 (schema), fb65ebc (OAuth)

✅ **QB sandbox operation + dealer mapping** — 2026-07-28
- Detected the connected company was Intuit **sandbox** (dev keys); set env=sandbox to
  build safely. Seeded Sterling Kia/Subaru/Auto Group as QB customers (idempotent),
  persisted verified customer IDs on `dealerships` (K→Kia, U→Subaru, S&T→Auto Group).
- Files: `apps/quickbooks/{client,customers,invoices}.ts`, `apps/vehicle-entry/{schema,db}.ts`,
  `app/api/quickbooks/setup-dealers`, migration 0002.
- Validation: customers created, mapping persisted, invoice read path 200.
- Commit: aa08a7c

✅ **Dealer Invoice Specification** — 2026-07-28
- Learned invoice structure (customers, header, line format, pricing, append-vs-new)
  from forensic data + live read. File: `docs/Dealer Invoice Specification.md`. Commit: f4b6d8e

✅ **Dealer check-in data model** — 2026-07-28
- `dealer_scans` (34 cols) + `dealer_scan_events` (audit). File: `apps/dealer-checkin/schema.ts`,
  migration 0003. Commit: 6e9bae2

✅ **Business-rule engine + tests** — 2026-07-28
- Pure rules (pricing, prefix, line format, appendable selection, duplicate) with 18
  vitest unit tests. Files: `apps/dealer-checkin/rules.ts` + `rules.test.ts`. Commit: bb1d944

✅ **QB invoice write module** — 2026-07-28
- ensure item/account (Complete Detail / Detail Sales), create/append invoice, Due-on-receipt.
- Validated on sandbox: invoice $0 tax, correct lines/terms/due date.
- File: `apps/quickbooks/invoice-write.ts`, self-test `app/api/quickbooks/selftest-invoice`. Commit: a358d68

✅ **Dealer check-in orchestration service** — 2026-07-28
- `checkInDealerVehicle` + `previewDealerCheckIn`: dealer resolve → pricing gate → dup
  check → live append-vs-create QB write → work-board order → audit trail.
- Validated: 9/9 self-test checks (append/create/prompt/$125/duplicate), auto-cleanup.
- Files: `apps/dealer-checkin/{service,db}.ts`, self-test `app/api/dealer-checkin/selftest`. Commit: e02130e

✅ **Dealer check-in API routes** — 2026-07-28
- `POST /api/dealer-checkin/preview` (read-only) + `POST /api/dealer-checkin` (confirm,
  production-write guard via `X-QB-Write-Approved`). Validated on sandbox. Commit: aab1300

✅ **Dealer Check-In UI** — 2026-07-28
- Camera-first `/dealer-check-in`: live VIN barcode scan + one-frame tag OCR
  (stock/color), NHTSA decode, ONE confirmation screen (Dealer/Year/Make/Model/
  Color/Stock + line + rate), inline $125 toggle, duplicate warning + Check-In-
  Anyway, low-confidence retake, one-tap "Looks Good" → Work Board redirect.
  Gloves/sunlight design (big targets, high contrast, black bg, minimal typing).
- Files: `app/dealer-check-in/{page,DealerCheckInFlow}.tsx`,
  `app/api/dealer-checkin/ocr/route.ts`, home launcher tile.
- Tests: 20 unit tests (added S-prefix-no-prompt + case-insensitive tag regression);
  pages render 200; OCR/preview error paths graceful. Commit: 0dd7dc9

✅ **Offline QB queue + retry + instrumentation** — 2026-07-29
- QB unavailable at check-in → Work Board order still created, invoice queued
  (`qb_sync_status='queued'`); `POST /api/dealer-checkin/retry-queue` drains +
  completes writes (idempotent). `GET` returns queue depth. `scan_duration_ms` +
  `qb_latency_ms` captured (migration 0004).
- Validated end-to-end on sandbox (inject queued scan → drain → synced to #1039);
  full self-test still 9/9 after refactor. Files: `apps/dealer-checkin/{service,db,
  schema}.ts`, `app/api/dealer-checkin/retry-queue`. Commit: (this milestone)

✅ **Check-in metrics dashboard** — 2026-07-29
- `getCheckInMetrics` aggregates production scans (throughput, today, avg scan
  time, avg QB latency, duplicate rate, prompt count, synced/queued/errors);
  `GET /api/dealer-checkin/metrics`; admin page `/admin/dealer-checkin` with a
  "Drain queue" control. Aggregation math validated (avg/filter/rate). Commit: eedc35c

✅ **Scheduled queue drain** — 2026-07-29
- `GET /api/cron/drain-dealer-queue` (secret-guarded via `CRON_SECRET`) drains the
  queue automatically; `vercel.json` daily cron (Hobby-compatible). Sub-daily
  auto-drain needs a Vercel Pro plan (owner/billing decision). Commit: 5ce8493

✅ **Work Board sync validated** — 2026-07-29
- Confirmed a dealer check-in appears on the board instantly (order `arrived`,
  source `dealer`, vehicle + stock + invoice in notes) via the same `?new=`
  highlight + polling the retail flow uses. No leftover test orders after runs.

✅ **Dealer invoice overview (live, read-only)** — 2026-07-29
- `getDealerInvoiceOverview` + `GET /api/dealer-checkin/invoices` + admin section:
  per-dealer open QB invoices (number, vehicle count, total, open/sent), deduped by
  QB customer (S&T→Auto Group). Live from QuickBooks; safe on production. Owner sees
  dealer billing without logging into QB. Validated on sandbox. Commit: (this milestone)

---

# In Progress

**Check-in polish**
- Goal: verify camera on a real device; keep the Work Board instant.
- Status: next up. Engine + UI + queue + metrics + scheduled drain complete.
- Remaining: on-device camera test, Work Board sync polish.
- Blockers: none (sandbox). Production writes gated on owner approval + prod keys.
- Complexity: Low.

---

# Next Priorities
(ranked by labor removed)

1. **Production go-live** (owner-gated) — real books; needs Intuit production keys + https + terms.
2. **Dealer invoice actions** — mark-sent / close a period from Pitt Stop (owner-approved QB writes).
3. **Retail check-in parity** — bring the retail flow to the same one-tap bar.
4. **Sub-daily auto-drain** (owner-gated) — needs Vercel Pro for frequent crons.

---

# Future Features

## Operations
- Work Board (live) ✅ V1 · scheduling · inventory · technician time tracking
- Dealer check-in ✅ engine · retail check-in ✅ V1

## Sales
- Retail Estimator ✅ M1 · CRM · follow-up automation · online booking

## Accounting
- QuickBooks OAuth ✅ · auto invoicing (dealer) 🟢 · monthly reporting · bank reconciliation · AR aging alerts

## AI Employees
- Service Advisor · Dispatcher · Marketing · Customer Support · Accounting Assistant

## Management
- Dashboards · KPIs · profit reporting · multi-location rollup

---

# Technical Debt

| Item | Why | Risk | Fix | Effort |
|------|-----|------|-----|--------|
| Drizzle migration journal stale | Project uses `drizzle-kit push`; manual SQL runner used instead | Low | Reconcile journal or adopt push fully | S |
| QB mock provider still wired into legacy `invoice-sync.ts` | Vehicle-entry path predates live QB | Low | Point legacy path at live client when ready | M |
| Self-test routes create sandbox invoices (not cleaned in QB) | Sandbox harmless | Low | Optionally void sandbox test invoices | S |
| No auth on admin/API routes | V1 single-shop, no login yet | Medium | Add auth before multi-location/production exposure | M |
| Dealer resolution is first-letter prefix only | Matches current stock scheme | Low | Support multi-char prefixes if needed | S |

---

# Bugs

_None open._

Fixed:
- **Test VIN length** — Severity Low — self-test VINs were 18 chars vs `varchar(17)`.
  Root cause: synthetic VIN generator. Fix: 17-char generator. (Caught by validation loop.)
- **IPv6-only dev bind** — Severity Medium — browser couldn't reach `localhost:3000`.
  Root cause: Next dev bound IPv6 only. Fix: `next dev -H 0.0.0.0`.
- **OAuth state mismatch** — Severity Medium — callback failed. Root cause: cookie set on
  `127.0.0.1` but callback host was `localhost` (host-only cookie). Fix: use `localhost` consistently.

---

# Architecture

```
Dealer Check-In UI  (camera-first, one confirm screen)
    ↓
OCR (key tag) + Barcode (VIN)         ── low-confidence → retake
    ↓
VIN Decode (NHTSA)                    ── fail → auto-retry
    ↓
Pricing Engine ($200 / $125 prompt)
    ↓
Duplicate Detection (VIN / stock / open invoice)
    ↓
QuickBooks (live: append-to-open OR create-new)   ── unavailable → queue + retry
    ↓
Work Board (service order, arrived)   ── Neon down → fail safe, preserve scan
    ↓
Audit + Metrics (dealer_scan_events)
```

Source of truth: QuickBooks (financial), Pitt Stop (operational). Every QB target is
resolved by a LIVE read; sent invoices are never modified.

---

# Metrics
(2026-07-28)

- Total commits: 38
- TS/TSX LOC: ~18,900
- Test files / tests: 1 / 20 · pass rate 100%
- API routes: 54
- Pages: 31
- App modules: 6 (vehicle-entry, estimator, ai-learning, workflow, quickbooks, dealer-checkin)
- DB tables: ~20 · migrations (manual): 4
- Integrations: QuickBooks Online (OAuth + read/write, sandbox validated), NHTSA, OpenAI · Vercel Cron
- Features complete: OAuth, dealer mapping, invoice write, check-in engine + API
- Technical debt items: 5 · Known bugs: 0

---

# Decision Log

**2026-07-28 — Build the dealer pipeline on QuickBooks sandbox first.**
Reasoning: connected company was Intuit sandbox (dev keys); building on sandbox has zero
risk to real books and lets us create test data freely. Tradeoff: sandbox lacks real
Sterling data (seeded test customers). Impact: full pipeline validated safely; production
go-live is a clean, separate switch (prod keys + https + owner approval).

**2026-07-28 — QuickBooks is the invoice source of truth; resolve target by live read.**
Reasoning: the AutoLeap incident proved cached invoice state drifts. Tradeoff: an extra
live read per check-in. Impact: never append to a sent invoice; no silent overwrites.

**2026-07-28 — Never auto-select the $125 new-vehicle rate.**
Reasoning: neither signal (T prefix, white tag) is 100% reliable. Tradeoff: one extra tap
when a signal fires. Impact: no mispriced invoices; owner rule honored exactly.

**2026-07-29 — Queue-on-failure instead of failing the check-in.**
Reasoning: the operator's scan must never be lost and the vehicle must reach the
board even if QuickBooks blips. Tradeoff: an invoice may lag its Work Board order
briefly. Impact: order always created; invoice queued + auto-retried; idempotent
drain avoids double lines.

**2026-07-28 — Production-write guard on the confirm route.**
Reasoning: prevent accidental real-invoice creation. Impact: on prod env, writes require
`X-QB-Write-Approved`; sandbox runs freely.

---

# Long-Term Vision
(labor-elimination ideas — expand continuously)

- **Zero-touch dealer billing:** scan tags all day → invoices assemble themselves → monthly
  statements send automatically → payment reconciliation posts itself. No bookkeeper time.
- **AI Service Advisor:** greets retail customers, builds the estimate from photos, quotes,
  and books — no front-desk labor.
- **AI Dispatcher:** assigns vehicles to technicians by skill + load off the Work Board.
- **Auto follow-up:** post-service texts, review requests, re-detail reminders — no marketing labor.
- **Self-reconciling accounting:** match QB invoices to bank deposits, flag only exceptions.
- **Predictive staffing:** forecast daily volume from dealer patterns; recommend crew size.
- **Multi-location control tower:** one dashboard, 20 shops, exceptions surfaced not searched.
