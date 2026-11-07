# Approval package — Insurance Restoration Customer Acquisition (prepared 2026-11-07)

Everything below exists only on branch `feat/insurance-restoration` in the worktree
`/Users/torlanpittman/Projects/.ps-worktrees/insurance-restoration` (cut from production commit `021f7c1`), as local
files, or as drafts. **Nothing has been published, deployed, migrated, imported, enabled, spent or sent.** Each section ends
with the exact approval it needs. The main checkout (`cleanup/usability-pass`, 118 dirty files) was not touched.

## Revision 2 — 2026-11-07 correction pass (owner steering + independent review fixes)

The owner **approved the release and the proposed $600/month new-ad budget**; Codex independently verifies final
readiness and executes deploy/publish/ads — nothing in this worktree deploys itself. This revision changed code and
copy AFTER the verification evidence recorded below, so **the §1 test counts and the `dist/` outputs are STALE until
Codex re-runs the suite and rebuilds** (`npx vitest run apps/marketing website/wordpress/insurance-restoration app/marketing/restoration`,
`npx tsx scripts/build-restoration-pages.ts`, `tsc`, `eslint`, `next build --webpack`). What changed:

1. **Owner steering applied to all public copy** (pages + /quote form): glass replacement is third-party through the
   shop's existing partner (not named) — pages now say so; billing arrangements are unverified EITHER WAY, so the old
   blanket "we don't bill your insurance company" was removed along with adjuster-meeting promises and "every shard"
   absolute glass-removal claims. Every page carries the neutral process: *contact your insurer to open or discuss a
   claim; we provide an itemized estimate and damage documentation and coordinate the repair.* Guardrail tests updated
   to FORBID both billing-status claims and the absolutes.
2. **Attribution pass-through fixed** (review finding 1): the landing pages now ship a small self-contained script that
   forwards allow-listed incoming click parameters (gclid, utm_*, fbclid, ps_cid, ref — exactly
   `apps/appointments/attribution.ts` minus `lp`) onto the estimate CTAs and cross-page landing links, so a paid click
   is never relabelled `website`. Each link keeps its own `service` and `lp`. No cookies/storage/third parties; values
   are cleaned with the same filter the server applies; only the shop's own funnel/pages are rewritten. Tested by
   executing the shipped script's pure functions (gclid/UTM forwarding, hub→child chains, organic no-op, hostile input).
3. **Report corrections** (findings 2–4): missing restoration ad data is now **unknown (null), never $0**, even when
   other categories report (regression-tested: live meta + ceramic-only rollup). Unit economics were split and
   relabelled: *cost per paid lead* (spend ÷ Google Ads leads), *blended cost per completed job* (explicitly NOT an
   acquisition cost), and *paid CAC* (spend ÷ distinct NEW customers with an invoiced Google Ads job — repeat
   customers, organic and unknown-source jobs excluded; new = no earlier completed order on the customer record).
   Duplicate handling: the canonical lead of a duplicate group is now the one that converted/progressed, and ALL
   breakdowns count unique leads only, matching the funnel headline; duplicate rows stay visible and flagged.
4. **Labor-cost modeling and contribution REMOVED** (owner decision — actual labor costs are not captured):
   no owner-set percent, no contribution/margin figures or targets anywhere. The report states **profitability:
   unmeasured** (never $0, never an estimate). The `restoration_labor_cost_pct` setting, its server action and the
   0076 seed were deleted (0076 is unapplied outside PGlite, so revising it is safe; it now only adds columns + index).
5. **Generated illustrations approved** (owner): the renderer takes an asset manifest (`assets.json`) with per-image
   src/alt/caption/provenance; generated illustrations always render the visible caption *"Illustrative image — not a
   completed Pitt Stop job."*, are reused hub + service pages, are rejected on real-photo slots and may not claim
   before/after or real-job results (enforced + tested). Real photos are optional upgrades, **no longer a publish
   blocker**. Codex supplies the 4 generated landscape files/URLs; nothing renders until they exist in the manifest.
6. **WordPress export is self-contained** (finding 5): `wpBody` now includes production styles scoped entirely under
   a `.ps-restore` wrapper (no `body`/`:root`/bare-element rules, every used class covered — tested), so the
   `.wp.html` no longer depends on undefined theme classes and cannot leak styles into Avada.
7. **Safe report review harness**: `/marketing/restoration` rendering was split into a pure
   `RestorationReportView` + synthetic fixtures (`app/marketing/restoration/report-fixture.ts`), rendered without any
   DB by `ReportView.test.tsx` and `scripts/preview-restoration-report.ts` (writes HTML to
   `docs/insurance-restoration/evidence/`). This proves markup + honesty rules locally; the live page against real
   0076 data is still verified only in the deployed app after migration A.
8. **Search Console**: owner reports access was granted — recorded as owner-reported, **pending Codex verification**.

## Revision 3 — 2026-11-07 (late): live read-only verification + generated assets + review fixes

Facts from Codex's live read-only session and independent review (nothing was published, created, applied or spent):

- **Generated illustrations supplied**: the four landscape files live at
  `website/wordpress/insurance-restoration/dist/images/*.webp` with `assets.json` entries (provenance
  `"generated illustration"`, generation prompts recorded; all four visually inspected and visibly labelled).
  `assets.json` currently points at local `images/…` paths for previews; after the WordPress media upload the `src`
  values are replaced with the public URLs and the pages rebuilt. **Preserve these files.** GBP must never use them
  (real photos only there).
- **Search Console: access VERIFIED** for `https://www.pittstopdetailandautosales.com/` (in-app connected browser,
  signed in as Torlan Pittman, 2026-11-07). Supersedes "owner-reported, pending" in Revision 2 item 8.
- **Google Ads 684-374-8548**: accessible; an existing primary payment method is present; all 16 conversion actions
  reviewed — `booking_confirmed` exists (secondary, count One), `quote_requested` absent (expected pre-deploy). No
  campaign/ad/budget edits were performed. `campaigns.csv` was uploaded for **preview only**: 3 errors / 0 successes
  (current template requires an EU political-ads field) — no Apply, no campaigns created, no spend. Codex is adapting
  the CSV to the current official template; repo campaign content and budgets ($9 / $6 / $4.70, Paused) stay stable.
- **WordPress and Vercel**: the owner reports being logged in to BOTH — recorded as owner-reported, **pending Codex
  verification**. The Vercel MCP connection is still pending (no tools), so there is no deployed-version evidence yet.
- **Production schema preflight (read-only)**: endpoint `ep-morning-base-adq5h6rq-pooler`, role `pitt_stop_app`, local
  write guard ACTIVE. `quote_requests` exists with its original 10 columns and **NONE of the five 0076 columns or the
  damage_type index**. Confirms the §4 ordering: **apply migration A before deploying B** — the new `/quote` CTE writes
  those columns and would fail without them. No business data was read or written; no local tests ran against production.
- **Review fixes landed after Revision 2** (all source-only, suite re-run required): transitive duplicate-group merging
  (a bridging lead now merges two existing contact groups into one; canonical prefers completed > open > cancelled
  linked outcome, never "older cancelled" over "completed"); the landing-page attribution script now runs at
  DOMContentLoaded so late markup (the preview sticky CTA) is rewritten too, with fake-DOM execution tests; glass meta
  description shortened to the declared ≤155 contract (test tightened from the stale 160); public pages drop
  insurance-premium advice and speculative total-loss determinations (new guardrail tests); ads/GBP drafts drop
  "every shard"/"we handle everything"/fixed-sequence/total-loss lines in favor of glass-partner coordination wording;
  the report states the paid-metrics scope limitation (spend = restoration-mapped campaigns only vs. any-gclid
  attribution → category-level approximation, not exact campaign CAC).

## 1. What was built (and how it was verified)

| Deliverable | Where | Verification |
|---|---|---|
| Five SEO landing pages (hub + vandalism, overspray, water damage, glass cleanup) as WordPress-ready HTML + preview + SEO sidecar | `website/wordpress/insurance-restoration/{pages,render}.ts`, built output `dist/` (`<slug>.wp.html`, `<slug>.preview.html`, `<slug>.json`, `index.html`) | 47 content tests (`pages.test.ts`): forbidden promises, qualified insurer language, one H1, metadata lengths, CTA attribution, internal links, FAQ/Service JSON-LD = visible text, no images until real assets, no prices/reviews |
| Estimate funnel on the existing `/quote` form: damage-type picker (restoration group + detailing group), per-type prompts, claim status, incident date, insurance disclaimer, up to 4 photos, estimate-language success screen, `quote_requested` event (never on replay) | `app/quote/{page,QuoteForm,conversion}.tsx/.ts`, `apps/marketing/quote-shared.ts`, `apps/marketing/quote-request.ts`, `app/api/quote/route.ts` | unit tests (parse, claim-status normalisation, date rules, hash, email text), conversion tests, live dev-server validation run (see §3), mobile + desktop render |
| Durable storage + attribution: `quote_requests.damage_type / claim_status / incident_date / landing_page / attribution` written in the same atomic CTE; `lp` added to the attribution allow-list; landing-page-only visits classify as `website` | migration `drizzle/migrations/manual/0076_restoration_quote_requests.sql`, `apps/marketing/schema.ts`, `apps/appointments/attribution.ts` | PGlite integration tests run the real migration (twice, idempotent) |
| Taxonomy: `restoration` service category + classifier rules (overspray, vandal, keyed, break-in, broken glass, water damage, flood, extraction, mold/mildew, hail, insurance/claim) | `apps/marketing/{types,services,calendar}.ts` | classifier tests |
| Weekly report `/marketing/restoration` (new Marketing tab): funnel, revenue by damage type/channel, recorded parts+sublet cost, ad spend with provenance, separated paid unit costs (paid CPL / blended / paid CAC), profitability shown as UNMEASURED, matched/unmatched/duplicates, lead table with link-to-job shortcut | `apps/marketing/restoration-report.ts`, `app/marketing/restoration/{page,ReportView,report-fixture}.tsx/.ts` (Revision 2: labor-cost setting + action removed) | end-to-end integration suite (`apps/marketing/restoration.integration.test.ts`) + synthetic-props render tests (`ReportView.test.tsx`); live page render still needs 0076 in the deployed app (see §3) |
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
| A | Apply migration `0076_restoration_quote_requests.sql` to production Neon (`ep-morning-base-adq5h6rq`) via the owner role — adds 5 nullable/defaulted columns + 1 partial index to `quote_requests` (Revision 2 removed the former settings seed) | additive; columns can stay unused; no data rewritten | **yes — approved 2026-11-07; Codex executes** |
| B | Deploy branch `feat/insurance-restoration` (fast-forward onto `origin/main`; the push itself triggers Vercel production) | rollback = redeploy `021f7c1`; the form keeps working without 0076? **No** — the CTE writes the new columns, so A must precede B | **yes** (after A) |
| C | Publish the five WordPress pages (Custom HTML block from `dist/<slug>.wp.html`, Rank Math title/description from `dist/<slug>.json`), after real photos are added | unpublish/trash restores; back up each new page draft | **yes**, per page |
| D | Vercel Production env: add the new campaign ids to `GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON` as `restoration` (only after campaigns exist) | remove the keys | **yes** |
| E | GA4: mark `quote_requested` as a key event after the first real event; import into Google Ads as primary conversion | un-star | **yes** |
| F | Google Ads: import the 5 CSVs (campaigns stay Paused) | delete campaigns | **yes** |
| G | Google Ads: **enable** the three campaigns = commit up to $19.70/day ≈ $599/month | pause | **yes — this is the spend decision** |
| H | GBP: categories/services/description/photos per `GBP_AND_REVIEWS.md` | edit back | **yes** |

Suggested order: A → B → (verify `/quote` and `/marketing/restoration` in production with a synthetic lead on the owner's
instruction, then soft-cancel it) → C → E → F → D → G → H.

## 5. Owner decisions — RESOLVED 2026-11-07 (see Revision 2 for how each was applied)
1. **Glass fulfilment** — RESOLVED: third party through the shop's existing glass partner; pages say "we coordinate
   glass replacement through our third-party glass partner" without naming them.
2. **Billing / claim assistance** — RESOLVED: billing arrangements believed set up but NOT verified in detail, so pages
   assert nothing about billing either way and promise no adjuster meetings; they state the neutral process (itemized
   estimate + damage documentation; customer contacts the insurer; shop coordinates the repair).
3. **Labor cost** — RESOLVED: not required. The owner-facing setting and all contribution/profit figures were removed;
   profitability is reported as unmeasured until real costs are captured.
4. **Images** — RESOLVED: owner approved generated illustrative images (with the visible "Illustrative image — not a
   completed Pitt Stop job." caption) so launch does not wait on real photos; real photos remain optional upgrades.
5. **Budget** — APPROVED: release + up to $600/month for the new restoration ads. Codex verifies final readiness and
   executes; existing unrelated campaigns stay unchanged. The hail history caution stands ($9–$22 CPC, ~$253 per Google
   conversion): the staged launch (vandalism + overspray first, ~$15/day, add water damage only if CPL < $60) is still
   the recommended execution of the approved ceiling.
6. **Search Console** — owner reports access was GRANTED (owner-reported, pending Codex verification before any
   SEO reporting relies on it).
7. **Hub-page CTA** — stands as built (one CTA per damage type, approved with the release).

## 6. Costs
No new subscriptions. Postmark free tier covers expected quote volume. The only money is item G.

## 7. Deploy and rollback
Deploy: apply A with `DATABASE_URL_OWNER` (local only) using the existing manual-migration script; then fast-forward
`origin/main` to the branch head from the worktree and let Vercel build (`next build --webpack` passes locally);
verify the deployment id via the Vercel API, then open `/quote?service=overspray` and `/marketing/restoration`.
Rollback: redeploy `021f7c1` from the Vercel dashboard; leave 0076 in place (additive, inert for the old code).
Kill switches without redeploy: none needed for the form (it degrades to the old behaviour only by redeploy); ads =
pause; GA4 = un-star.

## 8. Weekly reporting definitions (what each number means — Revision 2)
- **Leads** = unique restoration estimate requests in the window by request date. Duplicates (same normalized phone or
  email) are flagged and excluded from the funnel AND from every breakdown; the canonical lead of a duplicate group is
  the one that converted/progressed, never just the earliest. All rows stay visible in the lead table.
- **Qualified** = lead status moved past `new` and not `lost`/`no_response` (a human judged it real).
- **Estimates** = a written estimate exists on the linked job (total > 0) or status `estimate_sent`+.
- **Booked** = linked to a job or status `booked`/`won`. **Cancelled** = linked job cancelled (never a completion).
- **Completed** = restoration jobs completed in the window (linked from a restoration lead or classified from job text), by completion date.
- **Invoiced revenue** = `job_estimates.total_cents` only when QuickBooks-anchored. **Quoted, not invoiced** shown separately. Refunds not modeled.
- **Costs** = recorded part/sublet line-item cost on invoiced jobs. **Profitability = UNMEASURED** (labor cost is not
  captured; no contribution or margin is computed — never $0, never an estimate).
- **Ad spend** = the Google Ads figure for campaigns mapped to the `restoration` category. No restoration rollup (even
  when other categories report) or API unavailable ⇒ spend is UNKNOWN (null), never $0; a genuine $0 requires an
  explicit restoration row reporting zero.
- **Cost per paid lead** = spend ÷ unique Google Ads–attributed leads.
  **Blended cost per completed job** = spend ÷ ALL completed restoration jobs (explicitly NOT an acquisition cost).
  **Paid CAC** = spend ÷ distinct NEW customers with an invoiced, Google Ads–attributed completed job (repeat/organic/
  unknown-source excluded; "new" = no earlier completed order on the customer record). All three are same-window
  approximations, not click-cohort tracking, and are null whenever spend or the denominator is unknown/zero.
- **SEO** = reportable once the owner-reported Search Console access is verified by Codex.
