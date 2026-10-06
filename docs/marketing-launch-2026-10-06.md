# Marketing launch — October 6, 2026

This release isolates the ten Marketing V1/A2P commits from cleanup/usability-pass onto production base a483e4b. Home-launcher conflicts retain the production layout; schema conflicts retain production order-photo support. No unrelated uncommitted work is included.

## Public domain

Pitt Stop controls pittstopdetailandautosales.com, not pittstopdetail.com. The customer surface is https://text.pittstopdetailandautosales.com with /sms-opt-in, /privacy, /terms and token-scoped /unsubscribe. Its root redirects to signup. A hostname-specific proxy allowlist rejects the OS, login, operational APIs, service worker and manifest on that hostname. The main WordPress site and internal Vercel hostname retain their existing routing.

Business website: https://www.pittstopdetailandautosales.com
Support: (979) 696-6640; Pittstopdetailbcs@gmail.com
Webhooks remain on https://pitt-stop-internal.vercel.app/api/twilio/sms/inbound and /status.

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
- The registration packet describes the implemented web signup flow, without claiming a QR code has already been placed at the counter or on estimates.

## Activation and rollback

Migrations 0046–0048 are additive and idempotent. Keep marketing_sms_live=false until actual A2P approval and signed callback verification; use only the owner-designated test number. No customer campaign is authorized. The initial send cap is 1.

If activation needs to stop, set marketing_sms_live=false (and marketing_enabled=false to hide the internal module). Leave audit records intact. To roll back code, restore the previous Vercel production deployment; the additive tables can remain. Do not remove tables or roll back unrelated production commits.

The current Twilio/DNS/A2P and deployment status belongs in the launch report; this file describes the release and does not imply carrier approval or a completed live test.
