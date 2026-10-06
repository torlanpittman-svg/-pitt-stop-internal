# Marketing Agent V1

> An AI-assisted marketing department built into Pitt Stop OS. Objective: **maximize profitable
> completed-job revenue** (ceramic → paint correction → premium interior → reactivation → ads → social),
> measured in attributed revenue, without damaging the brand. Ships **dark** behind `marketing_enabled`;
> every external send is **dry-run** until a provider is configured. Nothing here mutates QuickBooks.

## Module map (`apps/marketing/`)
- `schema.ts` — 10 tables (migration `drizzle/migrations/manual/0046_marketing.sql`).
- `types.ts` — shared vocabulary (service categories, statuses, channels, attribution sources).
- `profile.ts` — **the single source** of brand/company knowledge for all AI prompts + the comment assistant.
- `services.ts` — deterministic service-category classifier (ceramic / paint_correction / interior / general).
- `guardrails.ts` — brand-safety validation of any outbound copy (blocks guarantees/invented offers; warns on spam/urgency).
- `calendar.ts` — 12-week premium-service rotation (biased ~40% ceramic / 30% correction / 20% interior) + weekly FB cadence.
- `segments.ts` — pure segment engine (named segments + custom builder, reach estimates).
- `contacts.ts` — builds per-customer marketing aggregates FROM canonical customers/orders (lifetime revenue, avg ticket, categories, consent).
- `status.ts` — campaign state machine. `db.ts` — campaign/recipient persistence. `campaigns.ts` — recipient build + dry-run/live send.
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
`/calendar`, `/leads`, `/google-ads`, `/attribution`, `/report`, `/settings`.
Public: `/unsubscribe/[token]` (token opt-out, no auth, POST-only mutation).
Cron: `/api/cron/marketing-weekly-report` (Mon 07:00), `/api/cron/marketing-content-candidates` (daily 10:00) — read-only, fall-open unless `CRON_SECRET`.

## Auth / safety
- Every page, server action, and route re-checks `managerActor()` (from `@/apps/checks/authz`). The home tile is hidden unless manager + `marketing_enabled`. Surface also registered in `proxy.ts` for prod parity.
- **Consent enforced at recipient-build time**: unsubscribed / unreachable customers become audited `excluded` rows and are never sent to.
- **Dry-run is honest**: with no live provider, recipients are marked `suppressed` (reason `dry_run`), `sent_count` stays 0, and the campaign's `dry_run` flag is true. Nothing is ever recorded as `sent` unless a live provider accepted it.
- **Idempotent**: unique `(campaign_id, customer_id, channel)`; re-build inserts nothing new; a `sent` campaign is a safe no-op on re-send.
- **AI is never trusted for writes**: structured output is zod-validated and guardrail-checked; malformed or unsafe output falls back to a deterministic on-brand template.

## External integrations (status)
| Channel | Status | To enable |
|---|---|---|
| SMS | **Dry-run only** (no Twilio/number in repo) | `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` + implement `TwilioSmsProvider` |
| Email | **Dry-run only** (Pitt Stop's only real email is QB-native send; no ESP) | `MARKETING_EMAIL_PROVIDER=resend` + `RESEND_API_KEY` (or a QB bridge) + implement provider |
| Facebook | **Dry-run only** (internal content/comment queue works) | `FACEBOOK_PAGE_ID` / `FACEBOOK_PAGE_ACCESS_TOKEN` + implement publish/fetch |
| Google Ads | **Dry-run + manual import** (dashboard + recommendations work on imported data) | `GOOGLE_ADS_DEVELOPER_TOKEN` / `GOOGLE_ADS_CUSTOMER_ID` (read-only) + implement fetch |
| AI (copy/posts) | **Working** when `OPENAI_API_KEY` set (GPT-4o); otherwise deterministic templates | already wired |

## How to use
1. **Create a campaign**: Overview → New campaign → pick type/target service/segment/channel → Create draft.
2. **Generate AI copy**: on the campaign → "Generate AI copy" (or edit by hand) → copy is guardrail-checked.
3. **Build recipients**: "Build recipients" → segment resolves against live customers; ineligible become excluded rows.
4. **Approve + send**: "Approve (Ready)" (guardrails must pass) → "Send (dry-run)". With no provider, it suppresses + reports dry-run.
5. **Content**: Content page → weekly plan, generate/draft posts, turn completed-job before/after candidates into proof drafts, triage the comment queue.
6. **Google Ads**: import daily metrics per service category → see ROAS by service + recommendations.
7. **Attribution / Report**: Attribution shows revenue by source/confidence; Weekly Report is the owner's one-screen summary with WoW comparison.

## Settings
`marketing_enabled`, `marketing_require_approval`, `marketing_send_daily_cap`, `marketing_attribution_window_days`,
`marketing_high_value_cents`, `marketing_default_offer` (in `app_settings`, editable at `/marketing/settings`).
Durable brand knowledge is code (`profile.ts`), not settings.

## SMS consent & Twilio (phases 2–4)
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
