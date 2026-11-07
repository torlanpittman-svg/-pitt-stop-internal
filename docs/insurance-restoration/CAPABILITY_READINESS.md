# Capability Readiness Report — 2026-11-07 (Phase 0)

All checks were READ-ONLY in production systems. "Verified" means a real test was run in this session, not "installed".
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
| 6 | Search Console | search.google.com (both accounts); Site Kit; Rank Math Analytics | **no access** / not connected | 3 attempts | **BLOCKED** | organic impressions/clicks/rankings unavailable | owner: add pittstopautodetail@gmail.com as a GSC user, or connect Site Kit (Administrator, ~5 min) |
| 7 | GA4 | analytics.google.com property 320511550 | Administrator (both accounts) | read home report: 59 users / 76 sessions / 21 key events (7d) | **VERIFIED (read)** | no restoration events yet | `quote_requested` event added in code; star as key event after first real event |
| 8 | Google Tag Manager | tagmanager.google.com (authuser 1) | container GTM-KRW4VXL visible | listed account/container | **VERIFIED (read)** | — | no GTM change needed for this project (tags live in the app layout) |
| 9 | Google Business Profile | business.google.com → redirects to Search profile manager | account chooser shown (pittstopautodetail@gmail.com is the manager per memory) | not completed (would require interactive account pick) | **NOT VERIFIED this session** | — | read via the Search "profile manager" surface on request; all GBP edits held for approval |
| 10 | Competitor / SERP research | WebSearch | public | 4 local SERP queries | **VERIFIED (limited)** | SERPs are directory-heavy; no local specialist competitor found | see keyword doc |
| 11 | Build SEO pages + photo estimate form | repo (Next.js) + WordPress HTML export (`website/wordpress/insurance-restoration/`) | — | 47 content-guardrail tests (`pages.test.ts`), `tsc`, `eslint`, local `next dev` render of `/quote?service=vandalism` on a 390 px viewport | **BUILT + VERIFIED locally**; pages exist only as files, form only in this branch | WP publish + deploy held; real photos not yet supplied (10 placeholders) | — |
| 12 | Connect leads to Pitt Stop OS | existing `/quote` → `quote_requests` + `marketing_leads` → `linkLeadOutcome` → Job | — | PGlite integration test `apps/marketing/restoration.integration.test.ts` (10 tests: lead with photo → link → estimate → complete → invoice → report; duplicate, replay, provider failure, cancel, repeat customer) | **VERIFIED in test** (in-memory Postgres running migrations 0046/0072/0075/0076); the production `/quote` path itself has carried 1 live lead (`sent`) | lead→Job link is a manual manager step (by design: never match by name) | `/marketing/restoration` lists unmatched leads with a one-click link to the Leads linker |
| 13 | Preserve attribution | `apps/appointments/attribution.ts` keys (+ new `lp`) + `marketing_attribution` + `quote_requests.attribution` jsonb | — | unit tests (`public-host.test.ts`) + the integration test above assert gclid/utm/lp persist on the claim row and lead, with no PII in the attribution payload | **VERIFIED in test** | phone-call attribution not possible (no call tracking); Search Console still inaccessible | Google call asset in the Ads drafts; GSC access is an owner action |
| 14 | Match leads → estimates → jobs → invoices | `marketing_leads.service_order_id` + `job_estimates.qb_invoice_id` / applied `retail_invoice_members` | — | integration test: invoiced vs quoted-only vs cancelled vs unrelated-ceramic jobs | **VERIFIED in test** | invoiced ≠ collected; refunds/credit memos live in QB and are not modeled | report labels revenue "invoiced (QB-anchored)" and says so in its caveats |
| 15 | Reliable revenue / job costs / ad costs | QB-anchored invoice totals; `job_line_items.cost_cents` (part/sublet); Ads API category `restoration` | prod read (baseline script) + test | **Revenue VERIFIED; costs PARTIAL** — production labor lines carry 0 cost, so labor cost is MODELED from the new `restoration_labor_cost_pct` setting (0 = contribution shown as unknown, never as free labor); ad spend null when unavailable | contribution is MODELED and labelled so | owner sets the labor-cost % on `/marketing/restoration`; shop records sublet/part cost on restoration jobs |
| 16 | Repeatable reporting | `/marketing/restoration` (new tab) backed by `apps/marketing/restoration-report.ts` | — | report numbers VERIFIED by the integration test; page compiles (`tsc`, `eslint`) but was **NOT browser-rendered** locally — it needs migration 0076 and the local shell reads production (read-only) where 0076 is not applied | **Logic VERIFIED in test; page render UNVERIFIED** | GSC column unavailable; page render pending a dev-branch DB or preview deploy | render on a Vercel preview deployment after approval, before production |
| 17 | QuickBooks (read) | `quickbooks-readonly` MCP | not exercised | — | not needed (app has the QB anchors) | — | — |

## Blockers and the smallest fix for each
1. **Search Console access** — owner adds `pittstopautodetail@gmail.com` (or torlanpittman@gmail.com) as a Full user on the
   `pittstopdetailandautosales.com` property, OR completes Site Kit setup in wp-admin. ~5 minutes, no cost.
2. **Labor/sublet cost recording** — a process decision: enter cost on labor/sublet lines for restoration jobs (the field
   exists). Until then contribution is modeled from an owner-set labor-cost percentage.
3. **Glass fulfilment statement** — owner confirms the partner arrangement (who replaces glass, typical turnaround) so the
   glass page can state it truthfully.
4. **Claim-assistance wording** — owner confirms what staff will actually do (itemized estimate + photos; speak to adjuster
   on request?). Pages ship with the conservative version.

## Costs
No new subscriptions or paid tools are required or recommended. Postmark free tier (100 emails/month) already carries
booking + quote email; expected quote volume fits. Ad spend is the only proposed cost ($600/month, NOT approved).

## Independent next steps already taken (no approval needed)
Pages (files), funnel code, migration file 0076, report module + page, 251-file test suite green (3,238 tests), Ads Editor CSV drafts
(all campaigns Paused, not imported), GBP prep doc — all local to branch `feat/insurance-restoration` (see APPROVAL_PACKAGE.md).

## Approval required before
Publishing WordPress pages · pushing/deploying this branch · applying migration 0076 · creating/enabling Google Ads
campaigns or any budget · editing GBP · adding GA4 key events · any email to customers.
