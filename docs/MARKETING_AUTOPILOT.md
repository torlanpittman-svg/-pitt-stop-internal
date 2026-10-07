# Recurring marketing launch — October 2026

Owner direction: launch as soon as setup and testing pass. Start with two Facebook posts per week (Tuesday/Friday) and one email per month. SMS remains off; no advertising spend changes.

## What runs

`/marketing/launch` is a manager-only launch console, accessible even while the legacy marketing feature flag is off. It prepares the next 45 days of drafts in the existing campaign/post tables and shows readiness, content, status, and provider references. It never exposes server credentials. The old manual campaign send action is not the MailerLite autopilot.

`/api/cron/marketing-autopilot` runs daily at 16:00 UTC (10 a.m. CST / 11 a.m. CDT). Missing or invalid CRON_SECRET fails closed. The worker sends only 9 a.m.–6 p.m. America/Chicago, on the scheduled local date. The initial email uses the chosen launch date; subsequent monthly emails use the 15th. Missed dates are skipped; no catch-up burst. Change the launch date before activation if setup is delayed. An explicit later date can move the initial unsent email, but an accepted monthly slot cannot be sent again.

The agent starts with factual general-service templates and optionally rewrites using the existing OpenAI client. Unsafe output falls back to the template or requires review. Prices, discounts, availability promises, customer/job stories and photos are excluded from autonomous publishing. This first release does not select real job photos, reply to customers, or autonomously change offers.

## Required configuration

Apply additive manual migration `0049_marketing_autopilot.sql` before deploying the route.

Server variables:
- Existing CRON_SECRET (never rotate casually; other schedulers share it).
- MAILERLITE_API_TOKEN, MAILERLITE_GROUP_ID (dedicated owner-reviewed group), MARKETING_EMAIL_FROM (verified sender/reply address).
- FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN, FACEBOOK_GRAPH_VERSION (explicit supported Graph version).

Settings default off: marketing_autopilot_enabled, marketing_email_live, marketing_facebook_live, marketing_email_audience_reviewed, marketing_email_test_verified, marketing_facebook_test_verified. marketing_autopilot_policy must equal october-2026-v1. marketing_launch_date is an editable provisional date, not a declaration that launch occurred.

Record readiness flags only after evidence:
1. MailerLite account/provider approval; verify domain and sender. Current pricing lists Comfort/Power, while the campaign API docs still call custom HTML an Advanced feature. Verify actual account capability before any subscription purchase.
2. Review a dedicated group against purchase evidence, provider rules, previous opt-outs and duplicates. Never mark every existing customer subscribed. MailerLite's policy permits customers who purchased within the preceding two years; do not infer purchase dates solely from import dates. No automatic contact uploads/import/resubscribe.
3. Send an owner-only provider test and verify content, sender/reply address, links, and actual unsubscribe suppression before setting email_test_verified.
4. Verify the correct Facebook Page and permission to publish; perform a controlled publishing test before setting facebook_test_verified. A Facebook browser login alone is insufficient. Never store Page access tokens in source, logs or client settings.
5. Approve standing rules and activate only ready channels. A blocker on one channel does not block the other.

Email sending checks active provider group membership plus the canonical customer directory and local exclusions twice (including after draft creation). Any unknown, inactive or opted-out duplicate blocks the whole campaign. The first-release ceiling is 500 active group members. Provider-native unsubscribes/bounces remain suppressed; no reactivation is performed. The exact group filter is checked before scheduling. MailerLite owns delivery reports and suppression, while the local campaign records accepted/sending until reconciliation reports sent.

## Operational recovery

Unique monthly/date slot IDs plus conditional database claims prevent concurrent workers from publishing twice. No provider POST is retried automatically. A MailerLite draft reference is saved before requesting delivery. On an ambiguous network response or process crash, a job stays needs_review/preparing/publishing and must be checked against the provider before any manual recovery. Pausing prevents subsequent requests; it cannot recall a request the provider already accepted.

The global autopilot switch and independent channel switches are read again just before external sends. Skipping is allowed only before execution. Audit events are append-only. This worker does not use QuickBooks, Plaid, change invoice state, or depend on unrelated order-photo work.

## Account state at implementation

Pitt Stop website uses SMTP2GO; that does not establish a MailerLite account. Facebook Page management is accessible in-browser; Meta developer registration is pending owner completion. MailerLite sign-in/signup is pending. Google Ads account access is available, but API developer/OAuth credentials are not connected. Twilio has an upgraded account and service; SMS remains off without a sender/A2P approval/auth-token verification. No customer marketing was sent during implementation.

Public business pages remain on the real WordPress domain: https://www.pittstopdetailandautosales.com/sms-opt-in/ , /privacy/ , /terms/ . Internal operations remain behind their existing employee authentication.
