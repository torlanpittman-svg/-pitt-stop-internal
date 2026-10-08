# Marketing launch — October 6, 2026

This release isolates the ten Marketing V1/A2P commits from cleanup/usability-pass onto production base a483e4b. Home-launcher conflicts retain the production layout; schema conflicts retain production order-photo support. No unrelated uncommitted work is included.

## Public domain

Pitt Stop controls pittstopdetailandautosales.com, not pittstopdetail.com. The public pages are published on the existing WordPress website at https://www.pittstopdetailandautosales.com/sms-opt-in/, /privacy/, and /terms/. The site-wide footer links to all three. The signup page opens the dedicated, unauthenticated consent form at https://pitt-stop-internal.vercel.app/sms-opt-in; that form links back to the public website policies. This two-step path avoids the WordPress theme's incompatible iframe lazy loading. No DNS or main-domain routing changes were made.

A dormant hostname-specific proxy allowlist remains for text.pittstopdetailandautosales.com if a dedicated subdomain is configured later. No such subdomain is attached. The internal OS retains its existing authorization and routing.

Business website: https://www.pittstopdetailandautosales.com
Support: (979) 696-6640; Pittstopdetailbcs@gmail.com
Webhooks remain on https://pitt-stop-internal.vercel.app/api/twilio/sms/inbound and https://pitt-stop-internal.vercel.app/api/twilio/sms/status.

## Launch fixes

- Import the committed Badge component directly, resolving the isolated release's only missing UI dependency.
- Enforce marketing enablement, public signup/policy verification, Advanced Opt-Out, A2P approvals, webhook verification, Messaging Service configuration and callback base before live SMS dispatch.
- Re-read consent immediately before each send, preventing STOP from leaving a queued promotional recipient eligible.
- Record public signup and signed-webhook verification independently of merely entering a URL.
- Correct the Twilio status callback path and use TWILIO_WEBHOOK_BASE_URL.
- Support MARKETING_SMS_TEST_TO as a server-only recipient restriction for controlled activation.
- Return HTTP 503 when a webhook's database operation fails, instead of falsely acknowledging consent persistence.
- Use the displayed affirmative checkbox wording in the consent audit record, version v2-2026-10-06.
- Public SMS policy pages use customer-facing business wording and contact details while existing OS policy content remains on the internal hostname.
- The registration packet describes the website footer, public signup page, and linked consent form, without claiming a QR code has already been placed at the counter or on estimates.

## Activation and rollback

Migrations 0046–0048 are additive and idempotent. Keep marketing_sms_live=false until actual A2P approval and signed callback verification; use only the owner-designated test number. No customer campaign is authorized. The initial send cap is 1.

If activation needs to stop, set marketing_sms_live=false (and marketing_enabled=false to hide the internal module). Leave audit records intact. To roll back code, restore the previous Vercel production deployment; the additive tables can remain. Do not remove tables or roll back unrelated production commits.

The current Twilio/DNS/A2P and deployment status belongs in the launch report; this file describes the release and does not imply carrier approval or a completed live test.

## Manual email + Facebook sending (manager-initiated)

A manager can now manually send an approved email or publish an approved Facebook post from inside the OS, independent of autopilot and SMS.

- Email: on a campaign (`/marketing/campaigns/[id]`), the "Send email (MailerLite · manual, live)" section. "Prepare to send email…" (`?send=1`) fetches the authoritative MailerLite group audience and shows the exact approved subject/body, the live group count, connection blockers, and the current send status; a separate "Send email now" button is the explicit confirmation. It sends to the MailerLite group — never the campaign's DB recipient rows — and that distinction is shown on screen.
- Facebook: on `/marketing/content`, the "Publish to Facebook (manual, live)" section lists approved text posts with the exact copy, connection blockers, and an explicit "Publish to Facebook now" button. Photo posts are excluded (post the image on Facebook directly, then record the link).
- Reuses `MailerLitePublisher`/`FacebookPublisher` (`apps/marketing/providers/publishing.ts`) and `marketing_automation_jobs` as a durable claim ledger (`manual-<channel>-<id>` slot key; the claim uses the allowed `publishing` status, never a `planned`/`ready` due row) so the autopilot worker never selects or expires a manual item and the autopilot/launch history excludes them.
- Confirmation binds to the exact previewed subject/body + MailerLite audience fingerprint; an edit, pause, or audience change since preview rejects the send. Approval and audience are rechecked after the durable claim and again immediately before the provider call (before `createDraft` and before `send`).
- Prerequisite: MailerLite campaign content (designed emails) requires a MailerLite **Advanced** plan. Current account billing calls this Power ($25/month at 500 subscribers, observed October 8); no paid upgrade was purchased. Trial API-content access is unverified. HTTP 422 can also indicate invalid sender/content/audience, so the UI does not assume every rejection means a plan problem. Email audience must be explicitly reviewed on the Launch page (`marketing_email_audience_reviewed`) — a dedicated manager action that records the owner's confirmation that the MailerLite group is the intended eligible audience and does not grant anyone eligibility.
- Facebook connection is confirmed read-only (`verify`, showing the exact Page name/ID) on demand from the Content page; it is never inferred from env credentials.
- Not a dry-run: it refuses with a readable blocker when a channel is unconnected instead of silently converting. Requires no autopilot switch, cron secret, or launch date — only the channel connection and (for email) the reviewed-audience confirmation. Manager auth is re-checked server-side on every action.
- Idempotent and safe under uncertainty: a durable claim prevents double-sends; an already-accepted item is a no-op; an unknown network outcome moves the claim to `needs_review` (the MailerLite/Facebook id is persisted before delivery) and is NEVER retried automatically — a manager inspects the provider. Local unsubscribe/eligibility is rechecked (`assertAudienceAllowed`) before and after draft creation. Accepted is not delivered; the existing read-only reconciliation reports delivery. All actions audit to `marketing_events` (`manual_email_sent`, `manual_facebook_published`, `manual_send_blocked`).
- Code: `apps/marketing/manual-send.ts`; actions `sendCampaignEmailAction` / `publishPostFacebookAction` in `app/marketing/actions.ts`. No schema migration or new dependency. The dry-run campaign preview (`previewCampaign`/`dispatchCampaign`) is unchanged and still writes nothing.

### October 8 manual release verification

- Full suite: 1,272 passed / 127 files, zero failures. Type check, scoped ESLint, and webpack production build passed.
- MailerLite business account created under pittstopdetailbcs@gmail.com. API token saved as a secret production Vercel setting; group 200790991519614902 is an empty dedicated approved-subscriber group. Intended sender is the existing business email; actual send/delivery remains unverified. No customers imported or contacted.
- Facebook Page 61577140663301 found. Personal developer-account verification/restriction remains unresolved; owner requested investigating Instagram login instead. No Facebook token configured or post published.
- Automatic email/Facebook dispatch and SMS remain off. Manual publishing supports approved text/link posts; photos still require the existing manual-post record workflow.
