# Capability Readiness Report — 2026-11-07 (Phase 0)

This Phase 0 table is the HISTORICAL pre-release audit; the executed status below supersedes its held/pending entries.
At that time, all checks were READ-ONLY in production systems. "Verified" means a real test was run in this session, not "installed".
Automation browser = the Playwright MCP Chrome profile (Google authuser 0 = torlanpittman@gmail.com, authuser 1 =
pittstopautodetail@gmail.com). Nothing was published, launched, or changed in any account, except that reading Keyword
Planner volumes created a saved *plan* (id 1444077024) in the Ads account (no campaign, no spend).

| # | Capability | Tool / environment | Permission observed | Verification test | Result | Gap | Recommended solution |
|---|---|---|---|---|---|---|---|
| 1 | Inspect the website | WebFetch + Rank Math sitemaps | public | fetched sitemap index, 23 pages, 57 posts, /detailing/, 3 relevant posts | **VERIFIED (read)** | — | — |
| 2 | Edit the website | wp-admin in the automation browser | **Administrator** (full menu: Pages, Plugins, Users, Rank Math, Avada) | opened Dashboard, Site Kit, Rank Math Analytics | **VERIFIED (edit access exists)** | publishing = production change | hold; publish only on approval, back up each page first (prior precedent: ceramic page 7510) |
| 3 | Prepare and deploy app changes | git worktree off origin/main; Vercel MCP | repo write; Vercel API read | worktree created; deployment list read | **VERIFIED (prepare)**; deploy = approval | push to `main` auto-deploys | FF push only after approval; migration 0076 applied deliberately first |
| 4 | Read Google Ads campaigns/performance | ads.google.com (UI, authuser 0) + app's read-only API connection (prod env only) | account access to 684-374-8548 | read 7 campaigns, budgets, status, spend | **VERIFIED (read)** | API creds not available locally (by design) | app pages `/marketing/google-ads` already use the API in prod |
| 5 | Keyword demand / CPC research | Google Keyword Planner (inside Ads) | standard user | 23 keywords, US + College Station/Bryan volumes | **VERIFIED** | Ahrefs: "Insufficient plan"; Semrush: "no API units"; local volume tiny | use Keyword Planner + Hail Damage campaign history; no new subscriptions needed |
| 6 | Search Console | search.google.com via the connected in-app browser (Torlan Pittman) | access granted by owner | opened the `pittstopdetailandautosales.com` property read-only (2026-11-07, late session) | **VERIFIED (read)** — supersedes the morning BLOCKED finding | — | request indexing for the five pages after publication |
| 7 | GA4 | analytics.google.com property 320511550 | Administrator (both accounts) | read home report: 59 users / 76 sessions / 21 key events (7d) | **VERIFIED (read)** | no restoration events yet | `quote_requested` event added in code; star as key event after first real event |
| 8 | Google Tag Manager | tagmanager.google.com (authuser 1) | container GTM-KRW4VXL visible | listed account/container | **VERIFIED (read)** | — | no GTM change needed for this project (tags live in the app layout) |
| 9 | Google Business Profile | business.google.com → redirects to Search profile manager | account chooser shown (pittstopautodetail@gmail.com is the manager per memory) | not completed (would require interactive account pick) | **NOT VERIFIED this session** | — | read via the Search "profile manager" surface on request; all GBP edits held for approval |
| 10 | Competitor / SERP research | WebSearch | public | 4 local SERP queries | **VERIFIED (limited)** | SERPs are directory-heavy; no local specialist competitor found | see keyword doc |
| 11 | Build SEO pages + photo estimate form | repo (Next.js) + WordPress HTML export (`website/wordpress/insurance-restoration/`) | — | content-guardrail + attribution-script + scoped-CSS tests (`pages.test.ts`), `tsc`, `eslint`, local `next dev` render of `/quote?service=vandalism` on a 390 px viewport; preview rebuilt + browser-checked 390×844 and desktop after the 2026-11-07 revisions | **BUILT + VERIFIED locally**; pages exist only as files, form only in this branch | WP publish + deploy held; `assets.json` points at local `dist/images/` previews until the WordPress media upload | generated illustrations (owner-approved) supplied by Codex with visible provenance captions; real photos remain optional upgrades |
| 12 | Connect leads to Pitt Stop OS | existing `/quote` → `quote_requests` + `marketing_leads` → `linkLeadOutcome` → Job | — | PGlite integration test `apps/marketing/restoration.integration.test.ts` (10 tests: lead with photo → link → estimate → complete → invoice → report; duplicate, replay, provider failure, cancel, repeat customer) | **VERIFIED in test** (in-memory Postgres running migrations 0046/0072/0075/0076); the production `/quote` path itself has carried 1 live lead (`sent`) | lead→Job link is a manual manager step (by design: never match by name) | `/marketing/restoration` lists unmatched leads with a one-click link to the Leads linker |
| 13 | Preserve attribution | `apps/appointments/attribution.ts` keys (+ new `lp`) + `marketing_attribution` + `quote_requests.attribution` jsonb | — | unit tests (`public-host.test.ts`) + the integration test above assert gclid/utm/lp persist on the claim row and lead, with no PII in the attribution payload | **VERIFIED in test** | phone-call attribution not possible (no call tracking); Search Console still inaccessible | Google call asset in the Ads drafts; GSC access is an owner action |
| 14 | Match leads → estimates → jobs → invoices | `marketing_leads.service_order_id` + `job_estimates.qb_invoice_id` / applied `retail_invoice_members` | — | integration test: invoiced vs quoted-only vs cancelled vs unrelated-ceramic jobs | **VERIFIED in test** | invoiced ≠ collected; refunds/credit memos live in QB and are not modeled | report labels revenue "invoiced (QB-anchored)" and says so in its caveats |
| 15 | Reliable revenue / job costs / ad costs | QB-anchored invoice totals; `job_line_items.cost_cents` (part/sublet); Ads API category `restoration` | prod read (baseline script) + test | **Revenue VERIFIED; costs PARTIAL** — labor cost is not captured anywhere, so (owner decision 2026-11-07) **profitability is reported as UNMEASURED**: no modeled labor, no contribution figures; parts/sublet are recorded line-item costs; ad spend is null unless an explicit restoration rollup exists (never $0 by inference) | profitability unmeasured by design | future process improvement: record labor/sublet cost on restoration jobs |
| 16 | Repeatable reporting | `/marketing/restoration` (new tab) backed by `apps/marketing/restoration-report.ts` + pure `RestorationReportView` | — | report numbers VERIFIED by the PGlite integration suite; the VIEW is rendered locally with synthetic fixtures (`ReportView.test.tsx`, `scripts/preview-restoration-report.ts`) — no DB, no production access | **Logic VERIFIED in test; view render VERIFIED with synthetic props** | the LIVE page against real data still needs 0076 applied + deploy (production preflight confirmed 0076 absent); a Vercel preview is NOT a test target (shares the production DB) | verify live after migration A + deploy B, per APPROVAL_PACKAGE §4 |
| 17 | QuickBooks (read) | `quickbooks-readonly` MCP | not exercised | — | not needed (app has the QB anchors) | — | — |

## Blockers — all four morning blockers were RESOLVED on 2026-11-07 (see APPROVAL_PACKAGE Revisions 2–3)
1. **Search Console access** — RESOLVED: verified live (read-only) for the property via the connected browser.
2. **Labor/sublet cost recording** — NO LONGER A BLOCKER: the owner decided not to require labor-cost input. The report
   states profitability as UNMEASURED (no modeled labor, no contribution figures); recording labor/sublet cost on
   restoration jobs remains a worthwhile future process improvement, not a launch gate.
3. **Glass fulfilment statement** — RESOLVED: third party through the shop's existing glass partner; pages/ads/GBP
   drafts say "coordinated through our third-party glass partner" without naming them.
4. **Claim-assistance wording** — RESOLVED: neutral process wording everywhere (itemized estimate + damage
   documentation; the customer contacts the insurer; the shop coordinates the repair); no billing-status claims either
   way and no adjuster-meeting promises.

**LAUNCHED 2026-11-07 — see `RELEASE_PROGRESS_2026-11-07.md` (authoritative).** Logins verified; 0076 applied;
application source `0d35d6e29e379550733f791b89c4b246e6039b7c` deployed READY. Final suite = 253 files / 3,271 tests; 69 focused page tests,
production build and source lint passed. Four labelled illustrations uploaded (media 7626–7629), all five pages
published and republished with WordPress-safe attribution plus corrected theme/mobile estimate links. All five
live pages preserve gclid/UTMs. One approved live inquiry + shop email + GA4 event passed; never repeat.
All five adapted CSVs were applied, then all three campaigns enabled: **Eligible (Learning)**, $19.70/day total,
existing campaigns unchanged. Production category map saved before the READY deployment. Remaining: shop-PIN
sign-in for live report/spend verification; Google asset review/indexing; monitoring. The old Vercel manual
redeploy/code request was cancelled and is obsolete. Final all-page 390 px visual QA is not claimed (tool limitation).

## Costs
No new subscriptions or paid tools are required or recommended. Postmark free tier (100 emails/month) already carries
booking + quote email; expected quote volume fits. The owner approved up to $600/month for the three new campaigns; their configured total is $598.88 per 30.4-day month.

## Independent next steps already taken (no approval needed)
Pages (files), funnel code, migration file 0076, report module + page, 251-file test suite green (3,238 tests), Ads Editor CSV drafts
(then "Paused, not imported" — since APPLIED and all three campaigns ENABLED on 2026-11-07; see RELEASE_PROGRESS_2026-11-07.md),
GBP prep doc — all local to branch `feat/insurance-restoration` (see APPROVAL_PACKAGE.md).

## Approval gates — final state (2026-11-07)
The original gates (publish pages · deploy · apply 0076 · create campaigns · GA4 key event) were each APPROVED and
EXECUTED on 2026-11-07, including enabling all three campaigns (record: `RELEASE_PROGRESS_2026-11-07.md`).
GBP profile edits remain unexecuted drafts; any customer email beyond the single closed, owner-authorized test inquiry remains forbidden; budget increases
beyond $600/month for these three campaigns would be a NEW approval.
