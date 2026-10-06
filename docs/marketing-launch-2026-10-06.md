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
