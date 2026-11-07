# Approval package — Insurance Restoration Customer Acquisition (prepared 2026-11-07)

Everything below exists only on branch `feat/insurance-restoration` in the worktree
`/Users/torlanpittman/Projects/.ps-worktrees/insurance-restoration` (cut from production commit `021f7c1`), as local
files, or as drafts. **Nothing has been published, deployed, migrated, imported, enabled, spent or sent.** Each section ends
with the exact approval it needs. The main checkout (`cleanup/usability-pass`, 118 dirty files) was not touched.

## 1. What was built (and how it was verified)

| Deliverable | Where | Verification |
|---|---|---|
| Five SEO landing pages (hub + vandalism, overspray, water damage, glass cleanup) as WordPress-ready HTML + preview + SEO sidecar | `website/wordpress/insurance-restoration/{pages,render}.ts`, built output `dist/` (`<slug>.wp.html`, `<slug>.preview.html`, `<slug>.json`, `index.html`) | 47 content tests (`pages.test.ts`): forbidden promises, qualified insurer language, one H1, metadata lengths, CTA attribution, internal links, FAQ/Service JSON-LD = visible text, no images until real assets, no prices/reviews |
| Estimate funnel on the existing `/quote` form: damage-type picker (restoration group + detailing group), per-type prompts, claim status, incident date, insurance disclaimer, up to 4 photos, estimate-language success screen, `quote_requested` event (never on replay) | `app/quote/{page,QuoteForm,conversion}.tsx/.ts`, `apps/marketing/quote-shared.ts`, `apps/marketing/quote-request.ts`, `app/api/quote/route.ts` | unit tests (parse, claim-status normalisation, date rules, hash, email text), conversion tests, live dev-server validation run (see §3), mobile + desktop render |
| Durable storage + attribution: `quote_requests.damage_type / claim_status / incident_date / landing_page / attribution` written in the same atomic CTE; `lp` added to the attribution allow-list; landing-page-only visits classify as `website` | migration `drizzle/migrations/manual/0076_restoration_quote_requests.sql`, `apps/marketing/schema.ts`, `apps/appointments/attribution.ts` | PGlite integration tests run the real migration (twice, idempotent) |
| Taxonomy: `restoration` service category + classifier rules (overspray, vandal, keyed, break-in, broken glass, water damage, flood, extraction, mold/mildew, hail, insurance/claim) | `apps/marketing/{types,services,calendar}.ts` | classifier tests |
| Weekly report `/marketing/restoration` (new Marketing tab): funnel, revenue by damage type/channel, parts+sublet cost, MODELED labor cost (owner-set %), ad spend with provenance, CPL/CAC/contribution, matched/unmatched/duplicates, lead table with link-to-job shortcut | `apps/marketing/restoration-report.ts`, `app/marketing/restoration/page.tsx`, `app/marketing/actions.ts` (`updateRestorationLaborCostAction`), setting `restoration_labor_cost_pct` | 10-test end-to-end integration suite (`apps/marketing/restoration.integration.test.ts`); page compiles — **not browser-rendered** (needs 0076 on a non-production DB; see §3) |
| Google Ads drafts (3 Search campaigns, Paused) + budget mechanics + conversion definitions + stop rules | `docs/insurance-restoration/GOOGLE_ADS_DRAFTS.md`, `docs/insurance-restoration/ads/*.csv` | copy length-checked programmatically; account history read (read-only) |
| GBP prep + review-request process | `docs/insurance-restoration/GBP_AND_REVIEWS.md` | — (drafts) |
| Research + baseline | `BASELINE_2026-11-07.md`, `KEYWORD_RESEARCH_2026-11-07.md`, `README.md`, `CAPABILITY_READINESS.md` | read-only production queries + Keyword Planner |

**Test evidence:** full suite `npx vitest run` → 251 files, 3,238 tests passed (2026-11-07 14:3x CT, worktree). `tsc --noEmit`
→ only the 11 pre-existing errors in `apps/estimates/quickbooks.test.ts` (present on production `021f7c1`, untouched).
`eslint` on all changed files → clean. `next build --webpack` → see §3 (log in the handoff folder).

## 2. Previews
- Landing pages: open `website/wordpress/insurance-restoration/dist/index.html` (links to the five previews; each preview
  is `noindex`, carries a "nothing on this page is live" bar, labelled PHOTO NEEDED placeholders and a review box with
  title/description lengths and the exact CTA URL).
- Estimate form: screenshots `docs/insurance-restoration/evidence/quote-vandalism-mobile.png` (390 px) and
  `quote-vandalism-desktop.png` (1280 px), taken from the local dev server on this branch.
- Report page: no screenshot (see §3, "not rendered").

## 3. End-to-end nonproduction test — what was demonstrated
In-memory Postgres (PGlite) running the real migrations 0046 + 0072 + 0075 + 0076, fake email provider, injected ad spend:
1. Synthetic lead (vandalism, claim status `filed`, incident 2026-11-05, one real 1×1 PNG, gclid + utm + `lp`) → one
   `quote_requests` row with the photo, damage type, claim status, incident date, landing page and the allow-listed
   attribution JSON (asserted to contain no name/phone/email) → one `marketing_leads` row (`source=google_ads`,
   `requested_service=restoration`) → one `marketing_attribution` row → `lead_created` audit event → one shop email whose
   subject says ESTIMATE and whose body carries the "do not promise coverage" reminder and the photo attachment.
2. Same key resubmitted → replayed, same lead id, no second email. Same person, new wording → second lead, flagged as a
   duplicate of the first in the report; funnel counts unique leads only. Duplicate detection matches on normalised phone
   OR email, never name.
3. Provider failure → lead and photo still saved, `emailed=failed`, report counts it under "shop email not sent".
4. Lead linked to a job (`linkLeadOutcome`) → estimate with labor $800 / sublet glass cost $220 / parts cost $30, total
   $1,200 → job completed → QB invoice anchor set → report: funnel 2 leads / 1 qualified / 1 estimate / 1 booked / 1
   completed / 1 invoiced; invoiced revenue $1,200; parts+sublet cost $250; labor MODELED at 35% = $280; ad spend $150 →
   CPL $75, CAC $150, contribution before ads $650, after ads $500; by damage type and channel correct.
5. Completed job WITHOUT a QB anchor → quoted $900, revenue $0; ad spend unavailable + labor % 0 → CPL/CAC/contribution
   **null** (rendered "—"/"Unavailable"), never zero.
6. Cancelled job → not a completion, no revenue; lost lead → not qualified. Repeat customer with two invoiced jobs → two
   orders counted once each, flagged repeat. Unrelated ceramic job in the window → excluded.

Live dev-server checks (this branch, `next dev` on :3111, reading production **read-only**; no valid submission was sent
because a valid one would attempt a write and the local guard blocks production writes):
- `/quote?service=vandalism&…&lp=car-vandalism-repair` renders "Request an Estimate", the grouped picker, claim status,
  incident date, disclaimer, 4-photo input; every control has an accessible name (radios, 6 textboxes, textarea, 2
  comboboxes, date, file button, submit); 390 px layout has no horizontal overflow.
- `POST /api/quote` with invalid fields → 400 with per-field errors; future incident date → "cannot be in the future";
  PDF photo → "Photos must be JPEG, PNG or WebP"; 5 photos → "Up to 4 photos"; honeypot → 400. No DB write occurred.

**Not demonstrated:** the `/marketing/restoration` page in a browser (needs migration 0076 on a non-production database
or a Vercel preview deployment — its queries and numbers are covered by the integration tests); the GA4 event reaching
Google (needs a deployed page); WordPress rendering of the HTML inside the Avada theme.

## 4. Exact production changes requested (each a separate yes/no)
| # | Change | Reversible? | Approval needed |
|---|---|---|---|
| A | Apply migration `0076_restoration_quote_requests.sql` to production Neon (`ep-morning-base-adq5h6rq`) via the owner role — adds 5 nullable/defaulted columns + 1 partial index to `quote_requests`, seeds `restoration_labor_cost_pct=0` | additive; columns can stay unused; no data rewritten | **yes** |
| B | Deploy branch `feat/insurance-restoration` (fast-forward onto `origin/main`; the push itself triggers Vercel production) | rollback = redeploy `021f7c1`; the form keeps working without 0076? **No** — the CTE writes the new columns, so A must precede B | **yes** (after A) |
| C | Publish the five WordPress pages (Custom HTML block from `dist/<slug>.wp.html`, Rank Math title/description from `dist/<slug>.json`), after real photos are added | unpublish/trash restores; back up each new page draft | **yes**, per page |
| D | Vercel Production env: add the new campaign ids to `GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON` as `restoration` (only after campaigns exist) | remove the keys | **yes** |
| E | GA4: mark `quote_requested` as a key event after the first real event; import into Google Ads as primary conversion | un-star | **yes** |
| F | Google Ads: import the 5 CSVs (campaigns stay Paused) | delete campaigns | **yes** |
| G | Google Ads: **enable** the three campaigns = commit up to $19.70/day ≈ $599/month | pause | **yes — this is the spend decision** |
| H | GBP: categories/services/description/photos per `GBP_AND_REVIEWS.md` | edit back | **yes** |

Suggested order: A → B → (verify `/quote` and `/marketing/restoration` in production with a synthetic lead on the owner's
instruction, then soft-cancel it) → C → E → F → D → G → H.

## 5. Open decisions for the owner
1. **Glass fulfilment wording** — pages say "we are not a glass shop; we coordinate with the installer you or your insurer
   choose". Confirm, or name a partner shop to mention.
2. **Direct billing / claim assistance** — pages say "we don't bill your insurance company for you" and "we'll walk the
   adjuster through the estimate". Confirm this is what staff will do.
3. **Labor-cost percent** for the contribution figure (set on `/marketing/restoration`; 0 keeps contribution "unknown").
4. **Photos** — 10 real shop photos are needed (list in each `dist/<slug>.json` → `photosNeeded`). Pages can publish
   without images, but they will convert worse.
5. **Budget** — approve, trim or defer the $600/month ceiling; the account's own hail history ($9–$22 CPC, ~$253 per
   Google conversion) says the < $200 CAC target is unlikely at launch. Recommendation: launch vandalism + overspray only
   ($15/day ≈ $456/month) for 30 days, add water damage only if CPL < $60.
6. **Search Console access** — add `pittstopautodetail@gmail.com` as a Full user (5 minutes) so organic impressions can be
   reported; currently unavailable, not zero.
7. **Hub-page CTA** — the hub has one CTA per damage type (no generic estimate button) because the form must know the
   damage type; confirm that is acceptable.

## 6. Costs
No new subscriptions. Postmark free tier covers expected quote volume. The only money is item G.

## 7. Deploy and rollback
Deploy: apply A with `DATABASE_URL_OWNER` (local only) using the existing manual-migration script; then fast-forward
`origin/main` to the branch head from the worktree and let Vercel build (`next build --webpack` passes locally);
verify the deployment id via the Vercel API, then open `/quote?service=overspray` and `/marketing/restoration`.
Rollback: redeploy `021f7c1` from the Vercel dashboard; leave 0076 in place (additive, inert for the old code).
Kill switches without redeploy: none needed for the form (it degrades to the old behaviour only by redeploy); ads =
pause; GA4 = un-star.

## 8. Weekly reporting definitions (what each number means)
- **Leads** = unique restoration estimate requests in the window by request date (duplicates by phone/email removed, shown separately).
- **Qualified** = lead status moved past `new` and not `lost`/`no_response` (a human judged it real).
- **Estimates** = a written estimate exists on the linked job (total > 0) or status `estimate_sent`+.
- **Booked** = linked to a job or status `booked`/`won`. **Cancelled** = linked job cancelled (never a completion).
- **Completed** = restoration jobs completed in the window (linked from a restoration lead or classified from job text), by completion date.
- **Invoiced revenue** = `job_estimates.total_cents` only when QuickBooks-anchored. **Quoted, not invoiced** shown separately. Refunds not modeled.
- **Costs** = recorded part/sublet cost on invoiced jobs + MODELED labor (owner %). **Ad spend** = Google Ads, `restoration` category; "Unavailable" when the API is.
- **CPL** = spend ÷ unique leads. **CAC** = spend ÷ completed jobs. **Contribution** = invoiced − parts − sublet − modeled labor − spend; null when any input is unknown.
- **SEO** = not reportable until Search Console access exists (owner action).
