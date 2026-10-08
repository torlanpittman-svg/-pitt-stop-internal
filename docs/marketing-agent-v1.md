# Marketing Agent V1

> An AI-assisted marketing department built into Pitt Stop OS. Objective: **maximize profitable
> completed-job revenue** (ceramic → paint correction → premium interior → reactivation → ads → social),
> measured in attributed revenue, without damaging the brand. Ships **dark** behind `marketing_enabled`.
> Nothing here mutates QuickBooks.
>
> **V1 reality (owner decision 2026-10-08):** this is a **non-SMS, no-live-send** release. SMS is
> **deferred** (no Twilio/A2P activation work), and there is **no live email channel** (Pitt Stop's only
> real email is QuickBooks-native). Campaigns are **draft + preview only**: "Send" produces a **dry-run
> preview** that never texts or emails anyone, regardless of settings or env credentials
> (`apps/marketing/dispatch.ts` `SEND_DEFERRED`). Not deployed / not pushed — local work on
> `cleanup/usability-pass`.

## V1 scope & deferrals (read first)
- **SMS deferred.** Outbound SMS is hard-disabled in the dispatch/send path. The Twilio provider,
  consent model, opt-in page, A2P packet and quiet-hours/cap logic are **preserved** for a later
  activation pass but are not wired to any live send. "SMS Launch" is removed from the primary nav;
  `/marketing/sms` is reachable by direct link and shows a **deferred notice** + read-only A2P reference.
- **No send mechanism, non-destructive preview.** The only runtime path is `dispatchCampaign →
  previewCampaign`, which is READ-ONLY: it contacts no provider, does not transition the campaign, and
  does not touch recipient rows (they stay `pending`). There is NO `sendCampaign`/live-send code to
  bypass. Even with Twilio/email credentials or `marketing_sms_live` set, nothing is sent or mutated.
- **Honest, canonical reporting.** Completed jobs + revenue come from completed `service_orders` +
  `job_estimates`, deduped per order. "Invoiced" revenue is recognized ONLY on a real QB invoice anchor
  (`job_estimates.qb_invoice_id`); a completed job with no invoice has UNKNOWN invoiced value (never
  asserted as $0). Quoted/estimated completed-job value is reported SEPARATELY. See Reporting below.
- **Cron fail-closed.** The marketing cron endpoints require a secret; with none configured they deny.
- **Manager-validated actions.** Every server action re-checks `managerActor()` and validates its inputs
  (`apps/marketing/validation.ts`), failing closed on malformed enums/dates/amounts/ids. Expected
  validation errors surface as a readable `?err=` flash on the page — never an opaque prod 500.

## Module map (`apps/marketing/`)
- `schema.ts` — 10 tables (migration `drizzle/migrations/manual/0046_marketing.sql`).
- `types.ts` — shared vocabulary (service categories, statuses, channels, attribution sources).
- `profile.ts` — **the single source** of brand/company knowledge for all AI prompts + the comment assistant.
- `services.ts` — deterministic service-category classifier (ceramic / paint_correction / interior / general).
- `guardrails.ts` — brand-safety validation of any outbound copy (blocks guarantees/invented offers; warns on spam/urgency).
- `calendar.ts` — 12-week premium-service rotation (biased ~40% ceramic / 30% correction / 20% interior) + weekly FB cadence.
- `segments.ts` — pure segment engine (named segments + custom builder, reach estimates).
- `contacts.ts` — builds per-customer marketing aggregates FROM canonical customers/orders (lifetime revenue, avg ticket, categories, consent).
- `status.ts` — campaign state machine. `db.ts` — campaign/recipient persistence. `campaigns.ts` — recipient build + NON-DESTRUCTIVE `previewCampaign` (no send mechanism in V1).
- `consent.ts` — eligibility + unsubscribe (token-based, audited). `events.ts` — append-only audit log.
- `leads.ts`, `content.ts` (social posts + job→post candidates), `ads.ts` (Google Ads metrics + search terms).
- `attribution.ts` — touch→customer→order→revenue linkage + funnels. `report.ts` — weekly executive report.
- `recommendations.ts` — deterministic Google Ads recommendation engine. `comments.ts` — FB comment assistant (reply rules + escalation).
- `ai/` — `client.ts` (OpenAI GPT-4o, zod-validated, injectable), `campaign-copy.ts`, `social-post.ts`.
- `providers/` — SMS/Email/Facebook/GoogleAds interfaces + dry-run adapters + `getProviders()`.

## Database (migration `0046_marketing.sql`, additive + idempotent)
`marketing_preferences`, `marketing_campaigns`, `marketing_campaign_recipients`, `marketing_social_posts`,
`marketing_leads`, `marketing_attribution` (append-only), `marketing_events` (append-only audit),
`marketing_ad_metrics`, `marketing_search_terms`, `marketing_conversations`.
Cross-module FKs (customers / service_orders / order_photos) are declared in SQL only to avoid circular
schema imports (mirrors `0043_customer_links`). **Not applied to any DB** — ships as a file; tests run on PGlite.

## Routes (`app/marketing/*`, manager-gated)
`/marketing` (Overview), `/campaigns` + `/campaigns/new` + `/campaigns/[id]`, `/segments`, `/content`,
`/calendar`, `/leads`, `/google-ads`, `/attribution`, `/report`, `/settings`. `/marketing/sms` exists but
is **not in the nav** (deferred notice; direct link only).
Public: `/unsubscribe/[token]` (token opt-out, no auth, POST-only mutation).
Cron: `/api/cron/marketing-weekly-report` (Mon 07:00), `/api/cron/marketing-content-candidates` (daily 10:00)
— read-only; **FAIL-CLOSED**: require `CRON_SECRET` (Vercel Cron) or `MARKETING_CRON_TOKEN`; deny when neither is set.

## Auth / safety
- Every page, server action, and route re-checks `managerActor()` (from `@/apps/checks/authz`). The home tile is hidden unless manager + `marketing_enabled`. Surface also registered in `proxy.ts` for prod parity.
- **Consent enforced at recipient-build time**: unsubscribed / unreachable customers become audited `excluded` rows and are never sent to.
- **Dry-run is honest**: with no live provider, recipients are marked `suppressed` (reason `dry_run`), `sent_count` stays 0, and the campaign's `dry_run` flag is true. Nothing is ever recorded as `sent` unless a live provider accepted it.
- **Idempotent**: unique `(campaign_id, customer_id, channel)`; re-build inserts nothing new; a `sent` campaign is a safe no-op on re-send.
- **AI is never trusted for writes**: structured output is zod-validated and guardrail-checked; malformed or unsafe output falls back to a deterministic on-brand template.

## External integrations (status)
| Channel | Status | To enable |
|---|---|---|
| SMS | **DEFERRED (V1)** — dispatch forces dry-run regardless of config; no Twilio/A2P activation now | Future pass: set `SEND_DEFERRED=false`, restore the live branch, add `TWILIO_*` creds + A2P registration |
| Email | **No live channel (V1)** — dry-run only (Pitt Stop's only real email is QB-native; no ESP) | `MARKETING_EMAIL_PROVIDER=resend` + `RESEND_API_KEY` (or a QB bridge) + implement provider |
| Facebook | **Manual** — internal content/comment queue; posts are recorded manually (no API auto-publish) | `FACEBOOK_PAGE_ID` / `FACEBOOK_PAGE_ACCESS_TOKEN` + implement publish/fetch |
| Google Ads | **Manual import** (metrics + search terms entered by hand; dashboard + recommendations work on it) | `GOOGLE_ADS_DEVELOPER_TOKEN` / `GOOGLE_ADS_CUSTOMER_ID` (read-only) + implement fetch |
| AI (copy/posts) | **Working** when `OPENAI_API_KEY` set (GPT-4o); otherwise deterministic templates | already wired |

## How to use (manual V1 workflow)
1. **Create a campaign**: Overview → New campaign → pick type/target service/segment/channel → Create draft.
2. **Generate AI copy**: on the campaign → "Generate AI copy" (or edit by hand) → copy is guardrail-checked.
3. **Build recipients**: "Build recipients" → segment resolves against live customers; ineligible become excluded rows.
4. **Approve + preview**: "Approve (Ready)" (guardrails must pass) → **"Preview (dry-run)"**. This is always a
   dry-run in V1 — recipients are suppressed (`dry_run`), nothing is texted/emailed, nothing is recorded as sent.
5. **Content** (`/content`):
   - **12-week plan**: "Add this week's 3 posts" seeds Mon/Wed/Fri drafts on their cadence days — **idempotent**
     (won't duplicate a day already seeded).
   - **Draft / edit**: generate (AI/template) or write posts; the queue lets you **edit copy**, **approve**, and
     **schedule** (pick a date).
   - **Record a manual Facebook post**: set a post to **Posted** and paste the **published FB post link** — we never
     auto-publish; this just records what a manager posted by hand.
   - **Candidates**: completed jobs with 2+ photos + a known premium service are prompts only. We do **not** guess
     before/after from upload order — a manager picks + verifies the shots before publishing.
   - **Comment queue**: inbound comments are classified → safe topics get a suggested reply (editable); risky ones
     (refund/damage/legal/fleet) escalate. A manager edits the reply and marks it **answered** / **archived**.
6. **Leads** (`/leads`): add leads, then **link a lead to the real order it produced** via a server-side SEARCH
   (order number / customer name / vehicle — no UUIDs to copy, no manual revenue). Linking is allowed BEFORE
   completion; the report credits it dynamically once the job completes + is invoiced. Re-linking supersedes the
   prior link (append-only, audited). Paginated.
7. **Google Ads** (`/google-ads`): manually import daily **metrics** per service category and **search terms** →
   ROAS by service + honest recommendations. **No budgets are changed** — data entry only.
8. **Attribution / Report**: Attribution shows revenue by source/confidence (one row per unique completed job);
   Weekly Report is the owner's one-screen summary with WoW comparison.

## Reporting (completed revenue — canonical, honest)
- **Completed jobs** = DISTINCT completed `service_orders` (status `ready`/`delivered`, `completed_at` set, not
  cancelled) that carry ≥1 **active** marketing attribution touch, bounded by `completed_at`. Counted **once** per
  order; the representative touch is deterministic (last-touch → confidence → recency → id tie-break). A superseded
  lead link (not the latest row for that lead) is excluded.
- **Invoiced revenue** = the QB-anchored invoice total — recognized ONLY when `job_estimates.qb_invoice_id` is
  present. A completed job with no invoice yet has **unknown** invoiced value (it is simply not added — never
  asserted as $0, never the draft quote).
- **Quoted job value** (`quotedJobValueCents`) = the estimated value of completed jobs (draft total / approved
  price), reported SEPARATELY and explicitly **not** invoiced/collected. **Collected/paid** is not tracked locally
  (`collectedRevenueCents` is null) and never invented.
- **`byService`** is CANONICAL — jobs classified from each order's own `service_orders.services`, with Google Ads
  spend merged only for ROAS. Ad spend + the platform's own reported revenue/conversions are shown separately; an
  ad **conversion is not a completed job**.
- **Unverified touches** (no linked completed order) never fabricate a job. `linkRecipientOutcome` /
  `linkLeadOutcome` record attribution with an atomic insert-if-absent (append-only; the report is the dedup
  authority — it counts each order once regardless of audit-row count). Revenue is derived canonically at report
  time, so no manual revenue figure is required to link.

## Settings
`marketing_enabled`, `marketing_require_approval`, `marketing_send_daily_cap`, `marketing_attribution_window_days`,
`marketing_high_value_cents`, `marketing_default_offer` (in `app_settings`, editable at `/marketing/settings`).
Durable brand knowledge is code (`profile.ts`), not settings.

## SMS consent & Twilio (phases 2–4) — DEFERRED, preserved for later
> The code below is **built but not active**. SMS is deferred in V1: dispatch forces dry-run, the "SMS
> Launch" nav entry is removed, and the settings "SMS sending LIVE" toggle is replaced by a deferred
> notice. None of this is wired to a live send. It is documented here so the activation pass can resume it.
- **Migrations applied + validated on the real Neon DEV branch** (`ep-bold-surf-adhsy8f5`): 0046, 0047 (consent), 0048 (delivery). Production never touched; `.env.local` stays prod + guarded.
- **Consent model (0047):** a present phone number is NOT consent. SMS eligibility requires `sms_consent_status='granted'` (default `unknown` ⇒ ineligible). Imported/historical numbers never silently qualify. `marketing_consent_events` is an append-only audit trail (source, wording version, text, IP/UA). Unsubscribe + inbound STOP revoke consent. Email stays relationship-based + unsubscribe.
- **Opt-in:** reusable `SmsConsentDisclosure` component (never pre-checked, not bundled) + public `/sms-opt-in` page recording proven consent via `recordPublicOptIn` (matches/creates a prospect). This is the verifiable A2P opt-in URL.
- **A2P/compliance (`compliance.ts`):** versioned disclosure, compliant outbound composition (brand + `Reply STOP`), STOP/START/HELP keyword classification. Config in settings (brand, help, frequency, privacy/terms URLs, quiet hours, caps).
- **Twilio (`providers/twilio.ts`):** real `TwilioSmsProvider` (Messaging Service, server-only creds, E.164, provider message id, failure reporting). Webhooks at `/api/twilio/sms/inbound` + `/status` (public, X-Twilio-Signature validated): STOP→revoke (no double-ack), START→re-grant, HELP→reply, normal reply→conversation queue; status→delivery update.
- **Send safety (`dispatch.ts`):** live SMS ONLY when `marketing_sms_live` is ON **and** Twilio configured **and** within quiet hours; otherwise forced dry-run (never silent live). Per-run cap = min(campaign cap, global SMS cap). Idempotent (only `pending` processed; sent once). Manager approval (Ready) still required.
- **A2P blockers (flagged, not invented):** `/privacy` + `/terms` exist and are public but contain NO SMS language yet — they must add SMS consent/frequency/"Msg & data rates"/STOP-HELP/no-sharing language before registration. Twilio brand/campaign registration + credentials are owner/external steps.

## What V1 does NOT do (guardrails)
No autonomous spend changes, no price changes, no invented discounts, no sending to unsubscribed users, no answering
disputes/refunds/damage/legal (auto-escalated), no autonomous Google Ads changes, no auto-posting, no deploy.

## Final verification — 2026-10-08 (non-SMS operating workflow)

- Claude implemented the scoped changes; Codex independently checked them.
- Clean verification copy: committed HEAD plus only these Marketing changes, with existing dependencies and no environment files or unrelated owner work. Marketing + actions + cron tests: **159 passed / 22 files**, no failures or skips.
- Full working-tree suite with two workers: **1,148 passed, 2 pre-existing failures / 1,150 tests**. Both failures are `apps/quick-entry/catalog.test.ts` seed-integrity/count drift, present before this work.
- Typecheck and scoped ESLint: passed. Clean Next webpack build: passed; all Marketing routes included.
- No migration added or applied in this pass. Database tests use isolated PGlite; the prior real-Neon DEV migration handoff was not revalidated here.
- No pushes, deployments, production database writes, customer messages, or external publishing. Owner work outside the scoped Marketing paths matches the original file hashes.
- Next rollout: review a Marketing-only integration branch against current production, verify the DEV environment and manager workflow, then obtain explicit deployment approval. Do not deploy this diverged working branch wholesale.

### First operating week (no SMS required)

1. Content: add the week's three drafts, choose ceramic/correction/interior focus, edit and approve. Publish manually on Facebook and record the published link.
2. Leads: record each inquiry and source, follow up, search for and link the actual order. No second revenue entry is required.
3. Google Ads: enter daily service-level spend/clicks/conversions; review recommendations manually.
4. Report: select the date range and compare completed linked jobs and invoiced values; distinguish platform-reported figures and unknown attribution.
5. Campaigns remain planning/preview only. Twilio, SMS activation and live marketing email are deferred.
