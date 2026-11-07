# Insurance Restoration Customer Acquisition — project record

Branch `feat/insurance-restoration`, worktree `/Users/torlanpittman/Projects/.ps-worktrees/insurance-restoration`, cut from
`origin/main` **021f7c1** = the Vercel production deployment `dpl_3dVFCBaQUPhvjsQexGZAzmREV2Wp` (verified via the Vercel
API 2026-11-07). The main checkout (`cleanup/usability-pass`, 118 dirty files) was left untouched.

Objective (owner brief, 2026-11-07): +$5,000/month completed insurance-related restoration revenue within 90 days of an
approved launch; Day-90 targets 15 qualified leads · 8 estimates · 5 completed jobs · $1,000 avg · CAC < $200 · positive
contribution after ads; proposed ad budget $600/month **subject to approval (not spending approval)**.

Companion files in this folder: `BASELINE_2026-11-07.md` (production numbers), `KEYWORD_RESEARCH_2026-11-07.md`
(Keyword Planner), `CAPABILITY_READINESS.md`, `GOOGLE_ADS_DRAFTS.md`, `GBP_AND_REVIEWS.md`, `APPROVAL_PACKAGE.md`.

---

## 1. Context Readiness Report

### 1.1 Repositories, branches, environments
| Item | Finding |
|---|---|
| App repo | this repo (Next.js 16 / React 19 / Drizzle / Neon / Vercel). GitHub `torlanpittman-svg/-pitt-stop-internal`, Vercel project `pitt-stop-internal` (team `pitt-stop`). |
| Production | `origin/main` 021f7c1 — every push to `main` auto-deploys to production (Vercel git integration; confirmed by the deployment meta). **So no push to `main` without approval.** This branch is never pushed by this work. |
| Public website | **Separate system**: WordPress (Avada theme, WooCommerce, Rank Math SEO, Site Kit installed but not connected) at `www.pittstopdetailandautosales.com`. Not in any repo. Content is edited in wp-admin (the automation browser is logged in as an Administrator). |
| Public app surfaces | `book.pittstopdetailandautosales.com` serves ONLY `/book`, `/quote`, `/privacy`, `/terms` + their APIs (`apps/appointments/public-host.ts`); everything else 404s on that host. `/quote` is live in production (HTTP 200 checked). |
| Databases | Neon production `ep-morning-base-adq5h6rq` (role `pitt_stop_app`, DML only). Local `.env.local` points at PRODUCTION with the fail-closed write guard ACTIVE (verified with `scripts/db-target.ts`). No separate staging DB. Non-production testing = PGlite in Vitest (the repo's established pattern) + a local `next dev` preview. |
| Test / preview | Vitest (247 test files on this base). Vercel preview deployments exist for non-main branches, but a preview still uses the production env (incl. production DB) — treat previews as read-only review surfaces, not test environments. |

### 1.2 Files reviewed and why they matter
- `CLAUDE.md`, `AGENTS.md`, `docs/ARCHITECTURE_MAP.md`, `docs/DATA_FLOWS.md` — invariants (append-only ledgers, QB owns money, idempotency, no parallel systems, deploy = scoped worktree + FF push with approval).
- `apps/marketing/{schema,types,services,leads,attribution,quote-shared,quote-request,report,ads-reporting}.ts`, `providers/google-ads.ts` — the existing lead/attribution/report model and the live read-only Google Ads connection.
- `app/quote/{page,QuoteForm,layout}.tsx`, `app/api/quote/route.ts`, `drizzle/migrations/manual/0071,0072,0075` — the public photo-enabled quote funnel (ceramic/headliner) shipped 2026-11-05, incl. request-key idempotency and the Postmark send fence.
- `apps/appointments/{attribution,public-host,checkin,notify}.ts`, `apps/appointments/db.ts` (linkAfterBooking) — how a booking becomes a lead + attribution row, and how check-in links the lead to the Job.
- `apps/directory/intake-customer.ts` — customer de-dup rule (unique non-placeholder email → phone, never name).
- `apps/workflow/schema.ts` (service_orders, job_estimates, job_services, job_line_items incl. `cost_cents`, line type `sublet`) — revenue and cost anchors.
- `app/book/{analytics,conversion,BookAnalytics}.tsx` — GA4/Ads tag privacy boundary (tag only on `/book` and `/quote`, sanitized page_location, no query strings).
- `app/marketing/{_components,leads/page,attribution/page,report/page}.tsx`, `app/marketing/actions.ts` — staff UI patterns to extend.
- `proxy.ts`, `vercel.json`, `next.config.ts`, `vitest.config.mts` — routing/gating, crons, build.
- `docs/APPOINTMENTS.md`, `docs/GOOGLE_ADS_CONNECTION_2026-10-28.md`, `docs/CERAMIC_CODEX_REVIEW_2026-11-05.md`, `docs/CERAMIC_RELEASE_LIVE_2026-11-05.md` and the main checkout's `CERAMIC_SIX_JOBS_*` docs — the most recent acquisition campaign (ceramic): WordPress landing page + `/quote` + Google Ads, and how it was published/approved.
- Live website: homepage, `/detailing/`, sitemap index (23 pages, 57 posts), the 2020 post "Repairs Covered by Insurance", 2021 "What to do when your car floods", "FAQ cosmetic bodywork".

### 1.3 How lead → estimate → job → invoice works today
1. **Lead capture.** Two public entry points, both on the booking host: `/book` (appointment; creates `appointments` row → `findOrCreateIntakeCustomer` → `marketing_leads` (status `booked`) → `marketing_attribution` first-touch row from `utm_*`/`gclid`/`fbclid`/`ps_cid`) and `/quote` (no appointment; one atomic CTE creates `quote_requests` + `marketing_leads` (`new`) + a `lead_created` audit event, stores photos on the claim row, then emails `service@pittstopbcs.com` via Postmark with the customer as Reply-To; `recordAttribution` adds a touch when click/UTM params exist).
2. **Estimate.** Staff build the estimate on the Job (`job_estimates` + `job_services` + `job_line_items`; retail Estimator / standalone `/estimates`). A `/quote` lead has NO automatic Job: staff reply by email/phone and, if the customer proceeds, create a Job (Quick Entry or Appointment) and link the lead on `/marketing/leads` ("Link to order", `linkLeadOutcome`). For `/book` leads the link happens automatically at check-in (`checkin.ts`).
3. **Job.** `service_orders` lifecycle (Work Board); completion sets `completed_at` (never changed later).
4. **Invoice / revenue.** Retail QB invoice created from the Invoice Draft; `job_estimates.qb_invoice_id` is the ONLY revenue anchor the marketing report trusts (`attributedCompletedJobs`): invoiced = QB-anchored `total_cents`; otherwise revenue is UNKNOWN (null), never zero. Collected/paid is not tracked locally.
5. **Reporting.** `/marketing/report` (weekly, by service category + channel, Google Ads live spend when configured) and `/marketing/attribution` (by source, deduped per order). Service categories are keyword-classified from the order's service text (`apps/marketing/services.ts`); there is **no restoration category** yet, so restoration jobs roll up as `other`/`paint_correction`/`interior`.

### 1.4 Existing functionality reused (nothing parallel built)
- `/quote` funnel (form, photo downscale, request-key idempotency, atomic claim CTE, Postmark send fence, honest success screen) → extended with damage types, incident description, claim status, landing-page capture, more photos.
- `marketing_leads` / `marketing_attribution` / `linkLeadOutcome` / `attributedCompletedJobs` → extended, not replaced, for the funnel report.
- `apps/appointments/attribution.ts` key allowlist + `classifySource` for channel; `app/book/analytics.ts` privacy boundary for GA4.
- `apps/marketing/ads-reporting.ts` live Google Ads spend (needs only a `GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON` mapping once campaigns exist).
- `findOrCreateIntakeCustomer` de-dup rule for matching leads to customers.
- WordPress + Rank Math for the SEO pages (publishing held for approval), the booking-CTA snippet convention (`?utm_source=website`), and the Postmark transactional provider.

### 1.5 Constraints, conflicts, missing context
- **No local/staging database.** Local env is production with writes blocked; all write-path testing is PGlite. A preview/dev Neon branch is a parked backlog item (`outstanding-backlog` memory). The end-to-end test in this project is therefore PGlite + local `next dev` — stated as such.
- **Labor cost is not recorded** on any job (0 of 238 labor lines in 12 months carry `cost_cents`); parts mostly are. Contribution profit must be MODELED until the shop records labor/sublet cost. Reported as an assumption, not a measurement.
- **Google Search Console: no access** from either Google account in the automation browser; Site Kit is installed but never connected; Rank Math Analytics state checked separately. Organic impressions/clicks/rankings are UNAVAILABLE (not zero) until the owner grants GSC access or connects Site Kit.
- **Keyword tools:** Ahrefs connector = "Insufficient plan"; Semrush = "no API units". Keyword Planner (inside the Ads account) is the only working source; local volumes are ≤ 10–40/month per phrase.
- **Glass fulfilment:** the website's own 2020 insurance post and the cosmetic-bodywork FAQ never claim in-house glass; historical glass-related jobs exist (7 in 24 months) but the shop sources glass through partners. Public pages must say "we coordinate replacement glass through a local auto-glass partner and handle the cleanup/interior" until the owner confirms otherwise.
- **Claim assistance / direct billing: UNVERIFIED.** Nothing in code, docs or the website shows direct-to-insurer billing. Pages promise only: itemized written estimate + photos the customer can submit to their insurer. No "we bill your insurance" claims.
- **Doc conflicts noted:** `AGENTS.md` still says "the ONLY email channel is QuickBooks" (stale — Postmark booking/quote email is live; `CLAUDE.md` is correct). `docs/GOOGLE_ADS_CONNECTION_2026-10-28.md` header says "not deployed" (stale — it is live; memory `google-ads-reporting-live`). The ceramic memory's "NOT deployed" note is superseded (3b54ebb is in production).
- **Prior attempt to learn from:** the paused **Hail Damage** Search campaign ($29.09/day, Maximize conversions) in the Ads account — its search terms/CPCs are the closest real-world signal for insurance-adjacent demand here; read before launch.
- **Side effect of research:** one Keyword Planner *plan* (id 1444077024) now exists in the Ads account; harmless, deletable.

## Build status (2026-11-07, end of session)
All authorized nonproduction work is done on branch `feat/insurance-restoration` (worktree
`/Users/torlanpittman/Projects/.ps-worktrees/insurance-restoration`, cut from production `021f7c1`):
- **Read first:** `APPROVAL_PACKAGE.md` (what was built, how verified, exact production changes, open decisions, rollback).
- Companion docs: `CAPABILITY_READINESS.md` (corrected to what was actually verified), `BASELINE_2026-11-07.md`,
  `KEYWORD_RESEARCH_2026-11-07.md`, `GOOGLE_ADS_DRAFTS.md` + `ads/*.csv` (Paused drafts, not imported),
  `GBP_AND_REVIEWS.md`, `evidence/` (form screenshots).
- Landing pages: `website/wordpress/insurance-restoration/` (source `pages.ts`, renderer `render.ts`, guardrail tests,
  built `dist/`; rebuild with `npx tsx scripts/build-restoration-pages.ts`).
- App: `/quote` extended, migration `0076`, `restoration` category, `/marketing/restoration` report + tab.
- Verification: 251 test files / 3,238 tests green; `tsc` clean apart from 11 pre-existing errors in
  `apps/estimates/quickbooks.test.ts`; `eslint` clean on changed files; `next build --webpack` exit 0.
- **Not done, by rule:** no push/deploy, no migration applied anywhere but PGlite, no WordPress publish, no Ads import or
  spend, no GBP edit, no GA4 key event, no customer email.
- **Doc-map note:** `docs/ARCHITECTURE_MAP.md` / `docs/DATA_FLOWS.md` do not exist on the production branch (they live on
  `cleanup/usability-pass` in the main checkout). When this branch merges, add a "Marketing → insurance restoration"
  entry there: files above, routes `/quote`, `/api/quote`, `/marketing/restoration`, table `quote_requests` (0076),
  setting `restoration_labor_cost_pct`, tests `apps/marketing/restoration.integration.test.ts` +
  `website/wordpress/insurance-restoration/pages.test.ts`.
