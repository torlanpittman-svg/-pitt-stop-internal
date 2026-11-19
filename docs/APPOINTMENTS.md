# Appointments — the AutoLeap booking replacement

Status (2026-10-19): **deployed to production** (see "Production state"). Public booking is **ON** in production
(turned on 2026-10-20 by the owner; intentional).

**The appointment time is the customer's drop-off time only** — not when work starts, not a bay, not a
technician. Capacity only spaces arrivals apart: one public customer per 15-minute time, no daily cap.

This module replaces the one AutoLeap function Pitt Stop still relied on day to day: the
**"Schedule a Drop-Off!" / Google "Book online"** link (`https://myalp.io/bhhjcb`). It is not a rebuild
of AutoLeap. Everything else in the retail flow already runs in Pitt Stop OS (see "Replacement matrix").

## Staff alerts for new online bookings
A new ONLINE booking also writes a `staff_alerts` row inside the booking statement and, separately,
pushes a notification to enrolled manager/admin phones (standard Web Push, no third-party service).
The in-app home-screen banner is the half that cannot fail. **See `docs/BOOKING_ALERTS.md`** for the
design, the duplicate-prevention rules, the migration/env/deploy steps and the phone acceptance test.
Not deployed as of 2026-11-02.

## Flows

**Public booking.** Website or Google button → `/book` (public, no login) → service → vehicle → drop-off
time (only real availability) → contact (+ optional, unchecked SMS-marketing box) → review →
**Confirm Appointment** → *Appointment Confirmed* screen (reference, Add to calendar, private
View/Cancel link). The booking commits atomically (see "Capacity and concurrency"), then best-effort:
canonical customer link (`findOrCreateIntakeCustomer`, never overwrites), SMS consent **only if the box
was ticked**, Marketing lead (`status=booked`) + first-touch attribution. Staff see it immediately on
`/appointments` under **New online bookings** (the shop alert, independent of email).

**Phone / walk-in / Facebook / Google / marketing lead.** `/appointments/new` → same rules as the public
page minus the online lead time; a manager can tick **Manager override** to book any time, a closed day
or past capacity (recorded as `capacity_override`).

**Arrival.** Appointment → **Check in → Work Board** → the existing `createQuickEntryJob` (customer match,
vehicle reuse, catalog services, draft estimate). One Job per appointment (claim + unique link + marker
recovery). The Job then follows the normal retail lifecycle → Invoice Draft → existing QuickBooks
Create / Send. Nothing in pricing, fees, Dealer Check-In or QuickBooks changed.

**Marketing.** Campaign/ad link with `utm_*`, `gclid`, `fbclid`, `ps_cid` (campaign id) or `ref` → booking
→ lead + `marketing_attribution` → check-in calls the existing `linkLeadOutcome` → the existing
completed/invoiced revenue report. No parameters ⇒ `unknown` (never guessed).

## Booking redesign + unfinished bookings (2026-10-20 — branch `feat/booking-redesign`, NOT deployed; review fixes 2026-10-20)

**Public flow, 3 steps** (`app/book/BookingFlow.tsx`, branded `BookShell` matching the website: Roboto, Courgette
heading, navy bar, red gradient pill buttons, logo/banner in `public/book/`):
1. **Service & vehicle** — service cards (Mini / Full / Premium Detail, Ceramic Coating, …); vehicle type
   (car-truck-SUV-van, motorcycle, trailer online; **RV and boat = "Call to schedule"** with a tap-to-call button);
   searchable dependent **Year → Make → Model** (`app/book/Combobox.tsx`, list-only — typed text that isn't in the list
   is reverted). Makes = curated list from `apps/vehicle-entry/vehicle-data.ts`; models = NHTSA vPIC
   `GetModelsForMakeYear` (same source the VIN decoder uses; no new decoder), cached; if vPIC is down, cars fall back to
   the curated model list and motorcycles show "call us". Trailers pick a trailer type. `apps/appointments/vehicles.ts`.
2. **Time & contact** — "drop-off time, not a finish time" callout; first/last name, phone, email all required
   (`apps/appointments/contact.ts`, validated again server-side); optional follow-up permission box (unchecked) and
   the separate, unchanged SMS-marketing box. **Continue to review** saves the draft (disclosure right above the button).
3. **Review & confirm** — Edit links, **Book my drop-off** (idempotent; the same request also closes the draft).
Each step is a browser-history entry: phone Back steps back with every answer kept.

**Unfinished bookings (leads)** — `apps/appointments/drafts.ts`, table `booking_drafts` (+ append-only
`booking_draft_events`), migration `0060_booking_drafts.sql` (also adds `appointments.vehicle_type`).
- Nothing is captured while typing; a draft is written only on **Continue to review** (`POST /api/book/drafts`, honeypot,
  20/hour per connection). A draft holds **no** time or capacity.
- Follow-up permission is stored with timestamp, exact wording and version (`draft-follow-up-v1-2026-10-20`); the save
  notice version is stored too. Marketing/SMS consent is separate and unchanged.
- Booking marks the draft `booked`, links the appointment and suppresses its follow-up in the same transaction.
- Follow-up: at most **one** email per draft and per address, only with permission, with an opaque resume link
  `/book/r/<token>` (HMAC, no PII, noindex, no-referrer). The resume page re-checks availability (the earlier time is
  re-offered only if still open) and says no appointment is confirmed.
- **Send pipeline** (`dispatchDraftFollowUps`): select → **claim** (`pending → sending`, conditional, stamps
  `follow_up_claimed_at`) → **final check** on the *current* row, in one transaction under a per-email advisory lock:
  still open, not booked (this draft or any appointment with that email/phone since the draft began), permission still
  given, lead not Closed, address not already emailed, no customer activity since the delay started → stamps
  `follow_up_cleared_at` → provider call, rendered from the current row. Failing the check: permission withdrawn →
  `not_permitted`; booked / closed / already emailed → `suppressed`; customer active again or changed details →
  back to `pending` (a full delay from the new activity). A change that lands *during* the provider call can't un-send
  the email; it is recorded as a `follow_up_raced_change` event, never silent.
- **Closed leads:** marking a lead Closed suppresses any unsent email (pending / not set up / failed) in the same
  statement and logs both `staff_status` and `follow_up_suppressed`. Closed leads are excluded at selection, claim and
  final check, and "Queue again" refuses them. Reopening a lead does not restart the automatic email.
- **Interrupted workers:** a claim older than 15 min (the job's own limit is 60 s) is recovered at the start of each
  follow-up or retention run. Never cleared → the provider was provably not called → back to `pending` (or `failed`
  after 3 attempts). Cleared → `uncertain` ("may have been sent"): **never retried automatically**, shown to staff, and
  it counts as "already emailed" for that address. A stuck row therefore delays erasure by at most one run.
- **Delivery certainty (shared with confirmations/reminders):** the provider result is `sent` only on a readable
  Postmark acceptance; `failed` only when non-delivery is established — a 4xx rejection (permanent: not retried
  automatically, staff may queue it again), 408/429/503 or a connection that never opened (ECONNREFUSED, DNS…: retried,
  max 3). Anything that might have been accepted — a lost/reset/timed-out response (20 s limit), a 2xx without readable
  acceptance details, any other 5xx — is **`uncertain`**: shown to staff as "Delivery uncertain — may have been sent",
  recorded in history, **never retried, never re-queueable**, and it blocks the follow-up (automatic or "Queue again")
  for every other draft with that address. Staff can confirm in Postmark's Activity log and contact the customer
  directly if needed.
- **Retention:** erases name, phone, email, notes, IP hash and attribution on drafts idle more than the retention period
  (open → `purged`; booked drafts keep `booked` and their appointment link). **Appointments are never touched.** Runs
  before the follow-up step, and with retention on an expired draft is never emailed.
- Staff: `/appointments/leads` (strict manager/admin only): contact, service/vehicle, last activity, permission, follow-up
  status (incl. "Interrupted — may have been sent"), New / Contacted / Closed (audited), "Queue again" for a not-set-up or
  failed email on an open, permitted, not-closed lead.

**Scheduling and timing tolerance.** The team is on **Vercel Hobby**: a Vercel cron runs at most once a day, so the
existing 5 PM `/api/cron/appointment-notifications` alone would turn a 24 h delay into up to ~48 h. A separate endpoint,
`/api/cron/booking-follow-ups` (same `CRON_SECRET` bearer, fail-closed), runs only retention + recovery + follow-ups and
is called **hourly** by the free GitHub Actions schedule `.github/workflows/booking-follow-ups.yml`; the daily cron
still runs them too as a backstop. Confirmations and reminders are unchanged (still the daily cron plus the immediate
post-booking dispatch). Resulting timing: **never earlier than 24 h after the customer's last activity** (enforced in
SQL at selection, claim and final check); normally sent **24 h–~25 h** after it, later only if GitHub delays a scheduled
run (it can at busy times) — worst case the daily backstop, ≤ ~48 h. GitHub usage: ~744 short runs/month, within the
free private-repo Actions allowance (personal accounts default to a $0 spending limit, so nothing is billed). The
workflow is **inert** until the owner adds repository secret `CRON_SECRET` (same value as Vercel's) and variable
`BOOKING_CRON_BASE_URL=https://pitt-stop-internal.vercel.app`; GitHub only runs schedules from the default branch.

**Owner-approved decisions (2026-10-20):** motorcycles and trailers book online; boats and RVs stay "Call to schedule";
enable **Premium Detail** (and rename "Complete Detail" → "Full Detail") when applying the booking settings; one
unfinished-booking email after **24 h** of inactivity, only with explicit permission; erase unfinished-booking contact
details after **90 days**; booking stays **ON** in production; keep `https://pitt-stop-internal.vercel.app/book` until
branded-domain access is resolved. Code defaults for both automations remain OFF — they are switched on in Booking
settings at release (recorded). **Real email stays off** until Postmark (account approval, sender domain DNS) is set up
and a controlled test is approved; until then follow-ups are recorded `not_configured`, never sent.

**Release order (each step needs explicit approval):** apply migration `0060` → deploy → Booking settings: Premium
Detail on, "Full Detail" label, follow-up ON (24 h), retention ON (90 days) → add the two GitHub settings → later,
Postmark + `APPOINTMENT_EMAIL_ALLOWLIST` controlled test → remove the allowlist.

**Email:** confirmation is now branded HTML + text ("Drop-off confirmed — …"), queued only after a successful booking,
still through the outbox/Postmark; a failure never undoes a booking, and the done screen only says "we're sending" when a
provider is configured. `APPOINTMENT_EMAIL_ALLOWLIST` (comma-separated) restricts sending to listed addresses for a
controlled test — everything else is recorded as skipped, not sent.

New default services are added **disabled**; names/descriptions are editable per service in Booking settings.

## "How did you hear about us?" (2026-11-07 — branch `feat/booking-hear-about-us`, NOT deployed; needs migration 0077)

Required on the public booking form (step 2, under the contact fields): a dropdown that starts on "Select an option" with
Google Search / Google Maps · Facebook · Instagram · Friend or Family · Returning Customer · Drove By / Saw Our Sign · Other,
and "Other" demands a short text. The rule lives once, in `apps/appointments/referral.ts` (`validateBookingReferral`):
the form runs it before "Continue to review", and `createAppointment` runs it again, so a hand-made POST cannot skip it.
Staff phone entries (`/appointments/new`) have the same dropdown but may leave it blank.

- **Stored** on `appointments.referral_source` / `referral_detail` (migration `0077_appointments_referral_source.sql`,
  nullable — bookings made before this question simply have `NULL` and keep working: reschedule, cancel, check-in untouched).
- **Shown** on the staff appointment detail under Marketing source as "Customer said" ("Not recorded" when absent; older
  bookings fall back to the linked Job's answer) and on the booking review step as "Heard about us".
- **Preserved** at check-in: copied to the Job's `service_orders.referral_source` (the same column Quick Entry fills at the
  counter) and to the marketing lead's `referral_source`, so the existing `/marketing/report` breakdown covers it.
- **Separate from automatic attribution.** `appointments.attribution` (utm_* / gclid / fbclid / ref) and
  `marketing_attribution` are untouched; the dropdown is never pre-filled from them and never overwrites them.
- Keys are the shared retail vocabulary (`apps/quick-entry/referral-source.ts`), extended with `facebook` / `instagram`
  (`REFERRAL_SOURCE_PLATFORMS`); the Quick Entry and quote pickers are unchanged.
- Not carried on unfinished-booking drafts: a resumed draft asks again (it is required anyway).

## "Attended — estimate declined" (2026-11-17 — branch `codex/appointment-estimate-declined`, NOT deployed; needs migration 0081)

A manager/admin outcome for a confirmed appointment with **no** linked Work Board job: the customer came
to the drop-off, received an estimate in person, and declined it. Distinct from cancel (chose not to come),
no-show (never came) and check-in (work accepted → Job). Recorded on the staff appointment detail via an
inline confirmation form with an optional reason (e.g. "price too high").

- **Status** `declined` (constraint extended by `0081_appointment_estimate_declined.sql` — idempotent
  and transactional, so a failed re-add can never leave the table unconstrained).
  Staff label "Attended — estimate declined"; customer page shows "Visit completed — no work scheduled".
  Terminal: it frees capacity (not in `ACTIVE_STATUSES`), blocks check-in/cancel/no-show/reschedule, and
  staff notes still work. `arrived_at` is **never** set — the outcome is retrospective; the recorded-at
  time is the `estimate_declined` appointment event's own `created_at`.
- **Fail-closed atomic statement** (`declineEstimate`, `apps/appointments/db.ts`), consistent lock
  order: the appointment row is locked `FOR UPDATE` with every eligibility condition (`confirmed`, no
  job, no check-in claim), then the linked lead row is locked `FOR UPDATE` (not Won, not job-linked) —
  joined off the **locked** appointment's `marketing_lead_id`, never a stale read. Only when both are
  locked and eligible do the updates run: `status='declined'` + `marketing_leads.status='lost'` +
  append-only `appointment_events` row (reason, lead outcome, lead id) + canonical `marketing_events`
  `lead_updated` (status, reason, appointmentId/Reference, `via: appointment_estimate_declined`) +
  pending confirmation/reminder/reschedule notices skipped. The decline and the lead's Lost **commit
  together or nothing is written** — a lead that turns Won/job-linked concurrently, or a dangling lead
  reference, refuses the whole decline with a conflict and leaves the appointment confirmed.
  **No cancellation email is ever queued** and already-sent notices are untouched. The dispatcher also
  retires any notice revived later (`staleReason` knows `declined`), without counting it a missed
  send — the customer was here in person.
- **Lead honesty:** the only outcomes are `'lost'` (lead moved with the decline), `'none'` (no lead was
  ever linked — stated, not claimed) and `'already'` (idempotent retry: no duplicate audit, never
  clobbers a lead a manager has since changed). There is no partial success. Attribution, source,
  revenue and estimates are never modified.
- **Race with check-in:** the check-in claim UPDATE now re-checks `status IN ('confirmed','arrived')`
  in SQL (it previously relied on a pre-read), so a decline can never be claimed over and turned into a
  Job; conversely decline refuses whenever `checkin_started_at` is set (a Job may be mid-creation).
- Tests: `apps/appointments/decline.integration.test.ts`, `decline-checkin-race.integration.test.ts`
  (PGlite), `app/appointments/decline-action.auth.test.ts`, UI rules in
  `app/appointments/[id]/AppointmentActions.test.tsx`. Handoff:
  `docs/APPOINTMENT_ESTIMATE_DECLINED_2026-11-17.md`.

## Lead Recovery — cancelled appointments (2026-11-19 — branch `feat/cancel-recovery`, NOT deployed; needs migration 0082)

A cancelled appointment becomes a row in **`appointment_recoveries`** (one per appointment, unique — a cancellation can
never get a second sequence). Managers work it at **`/appointments/recovery`**; when the owner switches recovery emails
on, up to three follow-ups go out through the **existing** outbox and provider (`appointment_notifications` →
`dispatchDue` → Postmark) as kinds `recovery_1..3`. No new provider, queue or dependency. Code: `apps/appointments/recovery.ts`.

**Ships dark.** `booking_config.recoveryEmailsEnabled` (master switch) and `recoveryAutoStart` both default **false**.
With the master switch off nothing can be queued or sent — automatically or by a manager — and anything already queued
is held and the sequence paused (it is a kill switch; turning it back on releases nothing by itself).

- **Who is enrolled** (`evaluateRecovery`, at cancel, best-effort after the cancel commits — it can never block one):
  customer-cancelled → queued, and started automatically only when both switches are on; origin not recorded → queued
  for **review** (never assumed to be the customer); **Pitt Stop-cancelled → never enrolled** and can never be emailed
  (a manager may queue it for a personal follow-up); customer already has another appointment → not enrolled.
  The staff cancel dialog now asks **"Who is cancelling?"** (Customer asked / Pitt Stop is cancelling), stored on the
  `cancelled` event as `meta.initiator`. No email, an unsubscribe, or no customer record → queued for a phone follow-up.
- **Older cancellations are never enrolled in bulk.** "Not in queue" lists them read-only with the verdict each would
  get; a manager adds one at a time, and adding never starts emails.
- **Timing:** emails at `recoveryDelayHours` (default 2 h / 72 h / 168 h after the cancellation, or after a manager
  starts it), pushed into the shop-local send window (`recoverySendStartHour`–`recoverySendEndHour`, default 8–19).
  The hourly `/api/cron/booking-follow-ups` dispatches recovery kinds only (`dispatchDue({ only: 'recovery' })`), so
  confirmation/reminder timing is unchanged; the daily cron is the backstop. **If the hourly GitHub schedule is not
  enabled, recovery emails go out once a day (~4–5 PM Central).**
- **Send-time gate** (`recoveryGate`, on the current rows, for the already-claimed notice): master switch, sequence
  still active, appointment still cancelled, not Pitt Stop-cancelled, valid email, **not opted out**, **email permission on record**
  (`marketing_preferences` for the customer or any customer sharing the address), **no new booking**, link window open,
  never two recovery emails at once. A provider-rejected address stops the sequence.
- **Stops:** customer books again · opts out · address rejected · staff Stop / Not interested / Recovered · window ends.
  Pause holds unsent emails; Resume re-times exactly those.
- **Rebooking link:** `/book/c/<token>` (HMAC of the recovery id, no customer data, noindex, no-referrer; stops
  pre-filling after `recoveryLinkDays`, default 30). Booking from it credits the cancellation (`rebook_match='link'`),
  re-uses the **original marketing lead** (same source, no second lead, no new `marketing_attribution` row) and does
  not fire the Google Ads booking conversion. Staff "Reschedule" from the queue → `rebook_match='staff'`. Any other
  later booking by the same email/phone stops the emails but is `rebook_match='contact'`, `rebook_review='pending'`
  until a manager confirms it.
- **Opt-out:** every recovery email carries the shop name, postal address and a link to the existing
  `/unsubscribe/<token>` page (also allowed on the booking host), plus a `List-Unsubscribe` header.
- **Reporting:** `/marketing/report` → "Cancelled appointment recovery" (`recoveryReport`). A rebooking is not revenue:
  money counts only when the credited appointment's job is completed **and** `job_estimates.qb_payment_status` /
  `qb_payment_balance_state` is `paid`; one booking credits one cancellation (unique index). Kept apart from Google Ads
  and source attribution.
- **Estimated value** uses real `service_catalog` prices only — a floor ("at least"), with unpriced services listed.
- **Email permission (added 2026-11-19):** the public booking form has an optional, **unchecked** "email me follow-ups
  and offers" box (`apps/appointments/email-consent.ts`). Ticking it appends an `opt_in` row to
  `marketing_consent_events` (channel `email`, source `website_form`, wording + version, time, IP, browser) and marks
  the booking's own `booked` event. **Recovery email requires it** — being a past customer is not permission. No
  permission → the lead waits in the queue for a phone follow-up; a manager can record permission the customer gave
  in person ("Customer agreed to email", source `manager`, saved under their name). Confirmation / reminder /
  reschedule / cancellation emails ignore the box entirely.
- **Postmark stream:** recovery emails go on the server's **broadcast** stream (`recoveryMessageStream()`, default ID
  `broadcast`; override with `APPOINTMENT_RECOVERY_MESSAGE_STREAM`). Booking notices stay on transactional `outbound`.
  Postmark adds its own unsubscribe link to broadcast mail and keeps its own suppression list; a suppressed or
  bounced address is then rejected at send (ErrorCode 406/300) and the sequence stops. Any other rejection (e.g. the
  stream does not exist) fails that email but is treated as a setup fault, not an undeliverable customer.
  **Before switching emails on, confirm in Postmark that the server has a broadcast stream with ID `broadcast`.**
- **Schedule:** the GitHub "hourly" job is live but GitHub runs it only ~3×/day (measured 2026-11-19). `vercel.json`
  therefore adds 13 once-a-day Vercel crons, one per hour 13:00–01:00 UTC (the 8 AM–7 PM Central window in both CST
  and CDT), each hitting `/api/cron/recovery-follow-ups/<slot>` — recovery kinds only. Vercel Hobby fires each some
  time within its hour, so an email goes out within about an hour of becoming due.
- **Interrupted runs:** every claim and every provider call is timestamped in `appointment_recovery_events`
  (`email_claimed`, `email_sending`). `recoverInterruptedEmails` (start of every run) turns a claim older than 15 min
  into `uncertain` if the provider call had begun (never resent) or back to `pending` if it had not.
- **Cancelled within 5 minutes of booking** (`isQuickCancel`): email 1 becomes "Need a hand with your booking?";
  emails 2 and 3 are unchanged. Flagged in the queue.
- **Payments taken directly in QuickBooks:** recognised by the existing Record Payment read path
  (`previewRetailPayment`, which adopts a zero QuickBooks balance) — but only when someone opened it on that job.
  The daily cron now calls it for recovered jobs that are completed, invoiced and not yet marked paid
  (`refreshRecoveredPayments`, ≤20/day, read-only against QuickBooks).
- **Historical import:** `scripts/recovery-backfill.ts` (dry run by default; `--apply` after 0082) queues the 8 past
  customer cancellations for manager review only. All 8 were cancelled within 5 minutes of booking and none has email
  permission on record, so none can be emailed until a manager records permission.
- **Not tracked:** inbox delivery, opens and replies (no Postmark webhook; replies reach `service@` via Reply-To).
- **Release order (each step needs owner approval):** apply `0082_appointment_recovery.sql` → deploy (queue works,
  nothing sends) → review the queue and email previews → Booking settings: turn on "Allow recovery emails", then
  optionally "Start follow-ups automatically". Tests: `apps/appointments/recovery.test.ts`, `recovery.integration.test.ts`.

## Rules (manager-editable at `/appointments/settings`, stored in `app_settings.booking_config`)

| Setting | Default |
|---|---|
| Online booking | OFF until a manager turns it on |
| Days / window | Mon–Fri, 7:15 AM → **11:00 AM cutoff** (inclusive), per weekday editable |
| Spacing | every 15 min (16 times) |
| Same-day | allowed, 60 min minimum notice (8:10 AM → first time 9:15 AM) |
| Horizon | 30 days |
| Holidays | 11 federal holidays closed on their **actual** date (no observed Friday/Monday); manager can re-open |
| Closures | manager whole-day or single-time blocks |
| Public drop-offs per time | **1** (`slotCapacity`) — a booked time disappears; the next time stays open |
| Daily appointment limit | **unlimited** (`dailyAppointmentLimit` = blank) |
| Workload limits | **OFF** (`workloadLimitsEnabled`). Service weights (correction/coating = 2) are stored but never close a time or a day while off; `dailyUnits` / per-category limits apply only when a manager turns this on |
| Manager override | managers can book any time, including an already-booked time (recorded as `capacity_override`) |
| Online cancel | until 60 min before; reschedule is staff-assisted (call) |
| Reminder | 24 h before, sent by the daily 5 PM cron; none for bookings already inside that window |

## Capacity and concurrency

`createAppointment` runs one Neon transaction: `pg_advisory_xact_lock(hashtext('appointments:'||date))`,
then a single `INSERT … SELECT … WHERE <capacity still available>` with its `booked` event and outbox rows
in data-modifying CTEs. Racing customers serialize on the per-day lock; the loser gets "That time was just
taken" and nothing is written. Reschedule does the same (both days locked, self excluded). Idempotency:
`appointments.idempotency_key` unique (one key per form submission), `external_ref` unique for AutoLeap
imports. Verified on Neon dev: 8 simultaneous requests for a 2-capacity time → exactly 2 booked; tests cover
6 simultaneous requests for one launch-model time → exactly 1 booked.

## Customer messages

Outbox `appointment_notifications` (confirmation / reminder / reschedule / cancellation), written in the
same transaction as the change, sent by `dispatchDue` (right after the request via `after()`, and by
`/api/cron/appointment-notifications` daily). A notice is `sent` only when a provider accepted it. Until the
provider env below is set, notices are recorded `not_configured`; the appointment page's **Customer email**
panel shows that per notice, with a manager-only "Send again" for provably un-sent ones (never for an
`uncertain` one — it may already have been delivered). To turn email on, see *Customer email (Postmark)*.
SMS is not used (no approved A2P registration). Vehicle-ready and invoice messages remain the existing
QuickBooks invoice email — **booking email is a separate channel and never touches QuickBooks.**

Three rules the dispatcher enforces, so switching a provider on cannot misfire:
- **A test-mode allowlist HOLDS, it does not discard.** A blocked recipient returns the notice to `pending`
  with the reason recorded and the attempt undone, so a controlled owner-only test can never silently consume
  a real customer's confirmation or reminder. It goes out once the allowlist is removed.
- **No backdated confirmations.** `staleReason` treats a confirmation/reschedule as stale once its drop-off
  time has passed (as well as when cancelled), so notices that sat un-sent cannot later mail "your drop-off
  is confirmed" about a past date. A cancellation notice is still always allowed.
- **Replies go to a human.** `APPOINTMENT_EMAIL_REPLY_TO` sets Reply-To on every customer notice; the sending
  address itself is unattended.

## Security

Public surface = `/book`, `/book/a/<token>`, `/book/r/<token>` (resume), `/api/book/availability` (yes/no per time only),
`GET /api/book/vehicles`, `POST /api/book/drafts`, `POST /api/book/appointments`, `/api/book/a/<token>/{cancel,ics}`. Everything else stays behind the employee
PIN (`/appointments/*` is in the proxy matcher) and manager role checks in each action. Private links are
an HMAC of the appointment id (`APPOINTMENT_TOKEN_SECRET`, falls back to `IDENTITY_SECRET`); only the hash is
stored. Server-side zod validation, honeypot field, 6 bookings/hour per connection. The dedicated host
`book.pittstopdetailandautosales.com` (when its DNS exists) serves only those routes — everything else 404.

## Files

`apps/appointments/` — `policy.ts` (pure rules), `db.ts` (atomic writes, reads), `checkin.ts`, `notify.ts`,
`attribution.ts`, `tokens.ts`, `public.ts`, `public-host.ts`, `schema.ts`, `vehicles.ts`, `contact.ts`, `drafts.ts`;
tests `*.test.ts`.
UI: `app/book/*` (public), `app/appointments/*` (staff). APIs: `app/api/book/*`,
`app/api/cron/appointment-notifications`. Migration `drizzle/migrations/manual/0058_appointments.sql`
(additive; 4 tables); `0060_booking_drafts.sql` (additive; drafts + events + `appointments.vehicle_type`). `apps/directory/intake-customer.ts`: vehicle link now optional.

## Replacement matrix (scope contract)

| AutoLeap function | Pitt Stop actually uses it? | Pitt Stop equivalent | Action |
|---|---|---|---|
| Website + Google "Book online" | **Yes** — both point to myalp.io/bhhjcb | none | **BUILD** (this module) |
| Appointment calendar | Yes (with booking) | none | **BUILD** (`/appointments`, minimal) |
| Booking confirmation / reminder | Yes (AutoLeap SMS) | none | **BUILD** outbox; delivery blocked on provider |
| Retail invoice → QuickBooks | **No longer** — last AutoLeap invoice #100886 on 2026-09-25; 19 retail invoices since are Pitt Stop OS (`PSID:`) | retail QB Create/Sync/Send (flags on) | VERIFY ONLY |
| Invoice delivery | No — QuickBooks `EmailSent` | QB native email | VERIFY ONLY |
| Payments | No — QuickBooks Payments / recorded in QB | QuickBooks | NOT USED — DO NOT BUILD |
| Customers / vehicles / history | Directory imported from AutoLeap CSV | canonical `customers`, `/customers` profiles | REUSE EXISTING |
| Work orders / estimates | No (since 9/25) | `service_orders`, estimates, Work Board | REUSE EXISTING |
| Vehicle-ready message | Unproven | QuickBooks invoice email on completion | VERIFY ONLY (owner confirm) |
| Future appointments in AutoLeap | Owner said none on 10/15; new ones may arrive until cutover | staff form, source "Moved from AutoLeap" | MIGRATE DATA (manual reconcile at cutover) |
| DVI, time clock, payroll, parts inventory, labor guide, dispatch/bays, CRM automations, loyalty, reviews, fleet, POS, financing, customer portal, reports | No evidence | — | NOT USED — DO NOT BUILD |

## Production state (2026-10-19)

- Deployed: origin/main `a910c15` (guard + capacity model + module + booking-host allowlist), Vercel
  `dpl_7p95z7LCoktQzY4LMnyUbmQCf4xg`. Migration `0058` applied to production and re-run (no-op). Public booking **OFF**.
- Private links use `IDENTITY_SECRET` (no `APPOINTMENT_TOKEN_SECRET` set). Do **not** add or rotate a token
  secret later without accepting that every customer link already issued stops working.
- **Final booking URL: `https://book.pittstopdetailandautosales.com/book`.** Attached to the Vercel project; needs ONE
  GoDaddy record (blocked on GoDaddy account recovery): `CNAME  book  →  81bdb230ad447ccd.vercel-dns-017.com`
  (Vercel's recommended value for this project). Host isolation verified on the edge (booking routes 200, `/` → `/book`,
  `/appointments`, `/work-board`, `/admin`, `/api/workflow/orders`, `/auto-sales/login` → 404).
  After HTTPS works, set `BOOKING_PUBLIC_BASE_URL=https://book.pittstopdetailandautosales.com` (email links only) and redeploy.
- `book.pittstopdetail.com` was evaluated and **dropped** (2026-10-19): the `pittstopdetail.com` zone is on Vercel DNS in a
  Vercel account this team does not control, and ownership is unconfirmed. The hostname is in the booking-only
  allowlist (harmless) and attached to the project **unverified** (Vercel serves `DEPLOYMENT_NOT_FOUND` for it).
  It is not part of the cutover; the owner may remove it at Vercel → pitt-stop-internal → Settings → Domains.
- Controlled test records (customer "ZZ Pitt Stop …", example.com email): PS-F8MFNS (checked in; its test Job
  SO-20261019-0005 soft-removed), PS-B3WTUR / PS-JC45FB / PS-QH9WPF / PS-DBY82N cancelled; smoke appointments cancelled.

## Website links (re-verified 2026-10-19 from the sitemap, 100 pages scanned)

All point to `https://myalp.io/bhhjcb` — **34 links on 15 pages**: home (3), pricing (5), shop (5), detailing (4), about,
contact, exterior-detailing, interior-detailing, mechanic-services (1 each), ceramic-coating-college-station (2), and the
5 product pages ceramic-coating, full-detail, mini-detail, premium-detail, pitt-stop-gift-card (2 each). Raw page text
has no other `myalp` occurrences. The site is WordPress (Avada-based theme + WooCommerce).

**Replacement operation (do only after the final URL passes its HTTPS controlled test):**
1. WordPress admin (must be an **Administrator**) → back up the database first (host backup or a backup plugin).
2. Plugins → Add New → **Better Search Replace** → install + activate.
3. Tools → Better Search Replace:
   - Search for: `https://myalp.io/bhhjcb`
   - Replace with: `https://book.pittstopdetailandautosales.com/book?utm_source=website`
   - Tables: select **all** (`wp_posts`, `wp_postmeta`, `wp_options` hold the Avada builder content + theme options)
   - Case-insensitive: off. Replace GUIDs: off.
   - **Run as dry run: ON** → it must report the matches (expect ≥ 34 field matches across posts/meta/options).
4. Run again with dry run OFF.
5. Avada → Options → Performance → **Reset Avada Caches**, and purge any host/page cache.
6. Re-scan the sitemap: `myalp.io` count must be **0**; spot-check home, pricing, shop and one product page buttons.
7. Leave Better Search Replace installed until verification ends (fast rollback = the reverse search/replace).

**Google Business Profile** (owner/manager of the profile): Google Search "Pitt Stop Detail" → Edit profile →
Bookings (or "Book online"/Appointment links) → replace `https://myalp.io/bhhjcb` with
`https://book.pittstopdetailandautosales.com/book?utm_source=gbp` → Save. If AutoLeap appears as a *booking provider*
(Reserve with Google) rather than a link, remove/disconnect that provider so only the link remains. Edits can take up
to ~10 minutes to a few days to show; check the live profile's Book button afterwards.

## Customer email (Postmark) — owner setup

Code is complete (outbox → `PostmarkEmailProvider`, `MessageStream: outbound`, branded HTML + plain-text). Notices are recorded
`not_configured` until all of this is done; nothing is reported as sent before a provider accepts it.

**The sending domain is `pittstopbcs.com`, NOT either Pitt Stop web domain.** Verified 2026-11-02 against both
authoritative nameservers: `pittstopdetailandautosales.com` and `pittstopdetail.com` each have **zero MX and zero
TXT** — no mail is received at either, and no address exists on them. Company email lives on `pittstopbcs.com`:
Google Workspace Business Starter (3 seats, paid from 2026-10-29), DNS on **Cloudflare**
(`delilah`/`ray.ns.cloudflare.com`), `MX 1 smtp.google.com`, SPF `include:_spf.google.com ~all`, Google DKIM at
`google._domainkey`. Mailboxes `torlan@` / `darryl@` / `tony@` plus the shared **`service@pittstopbcs.com`** group
all three monitor. **DMARC is still unpublished** — start at `p=none` once Postmark DKIM has settled.
→ **The old "blocked on GoDaddy" note no longer applies to email**: the records Postmark needs go in Cloudflare.

1. Create a Postmark account; create a Server (e.g. "Pitt Stop appointments"); request account approval (new accounts can
   only send to their own domain until approved). The free tier is enough for the controlled test.
2. Sender domain verification for `pittstopbcs.com` — in **Cloudflare**, add only the two records Postmark shows:
   its **DKIM TXT** (on Postmark's own selector) and the **Return-Path CNAME** (`pm-bounces` → `pm.mtasv.net`).
   **Do not touch the existing MX, SPF or `google._domainkey` records.** Postmark signs with its own selector and
   bounces via its own return-path, so the Google SPF record needs no edit and live Workspace mail is unaffected.
3. In Google Workspace, add `appointments@pittstopbcs.com` as a free alias on the `service@` group, so a customer
   who replies straight to the From address still reaches a monitored inbox.
4. Vercel (Production) env, then redeploy:
   - `APPOINTMENT_EMAIL_PROVIDER=postmark`
   - `POSTMARK_SERVER_TOKEN=<server API token>`
   - `APPOINTMENT_EMAIL_FROM="Pitt Stop Detail & Auto Sales <appointments@pittstopbcs.com>"`
   - `APPOINTMENT_EMAIL_REPLY_TO=service@pittstopbcs.com`
   - `BOOKING_PUBLIC_BASE_URL=https://book.pittstopdetailandautosales.com` (customer-facing links + the email logo)
   - `APPOINTMENT_EMAIL_ALLOWLIST=<owner addresses>` for the controlled test — **set it in the same change as the
     token**, never afterwards, so no real customer notice is attempted first.
5. Book once online with an allowlisted address; confirm the notice reaches `sent` with a provider message ID on the
   appointment's **Customer email** panel, and that the mail itself is correct. Then remove the allowlist (owner
   approval) — that deletion is the moment real customer email goes live.

One provider serves **all four** notice kinds. With `confirmationEnabled` and `reminderEnabled` both true in
production, removing the allowlist activates confirmations, reminders, cancellations and reschedules together;
unfinished-booking follow-ups stay off separately (`draftFollowUpEnabled`).

Email never blocks booking: the shop alert is the `/appointments` "New online bookings" list.

Delivery certainty: a notice is `sent` only on a readable acceptance and `failed` only when non-delivery is established
(4xx = permanent, not retried automatically but staff may retry; 408/429/503 or a connection that never opened =
retried). A notice that **may** have been accepted (lost or timed-out response, unreadable 2xx, other 5xx) becomes
**`uncertain`**: never resent, refused by staff retry, and logged in the appointment's History ("may have been delivered
— not resent"); a final definite failure is logged there too. Migration 0060 adds `uncertain` to the notice status check.

Known limits (acceptable for launch): a temporary failure retries after 15 min but is only picked up by the next dispatch —
the daily 5 PM cron, another change to that appointment, or staff **Retry customer messages** — and after 3 attempts it
stays `failed`. Delivery status shows on each appointment's page, not on the `/appointments` list. A notice whose
process dies mid-send stays `sending` (never re-sent → no duplicate email; staff can see it).

**Attribution:** `utm_source=website` → source `website`, reported as **Website** (Marketing leads + revenue report);
`utm_source=gbp` → `google_organic`. Raw UTM values are always stored on the booking and the attribution row.

**Staff display (appointment detail → Marketing source).** `describeBookingSource()` in `attribution.ts` turns the stored
tags into plain English — *Tracked source* (a `gclid` outranks the generic `utm_source=website` tag; a website tag alone is
“original source unknown”, never organic; Facebook/Instagram tags are never called paid), *Booking entry point* (website
button placements from `PLACEMENT_LABELS`, only the ones the website snippet emits) and a separate *Customer said* line
(the appointment's own `referral_source`/`referral_detail`; the linked Job's only as a fallback for older bookings). Raw tags sit under a collapsed “Tracking details”. Display only: `classifySource()`, the
ledger and stored data are unchanged.

## Cutover checklist

| Item | Status |
|---|---|
| Production deploy + migration + write guard | READY |
| Capacity settings (1 per 15 min, no daily cap, workload off, same-day 60 min) | READY (verified on prod settings page) |
| Controlled production test (app domain) | PASS 22/22; internal smoke 13/13 on `a910c15` |
| Future AutoLeap appointments | **READY — none exist** (owner confirmed 2026-10-19) |
| Final booking host `book.pittstopdetailandautosales.com` | PENDING — GoDaddy CNAME (account recovery) |
| Controlled re-test on the final host over HTTPS | PENDING — after CNAME |
| Public booking ON | **ON** on the app URL (owner, 2026-10-20, intentional); keep it until branded-domain access is resolved |
| Website links (34 / 15 pages) | Prepared (above); switch after the final-host test |
| Google "Book online" | Prepared (above); switch after the final-host test |
| Customer email | Not live (queued-only); does not block cutover; needs Postmark + GoDaddy DNS |

## Cutover runbook

1. GoDaddy CNAME above → verify `https://book.pittstopdetailandautosales.com/book` over HTTPS and that internal pages 404.
2. Short controlled re-test on that host (book → see it on `/appointments` → cancel).
3. Turn online booking ON at `/appointments/settings`.
4. Website search-replace + Google link (above).
5. Verification period (5–10 business days): AutoLeap stays available but unused; each day record whether anyone had
   to open it and why.

## AutoLeap archive / export checklist (before cancelling — do NOT cancel during verification)

Save everything into one dated folder (e.g. Google Drive "AutoLeap archive 2026-10"). AutoLeap is a raw archive only;
QuickBooks stays the record for invoices and payments.
1. **Customers** — Reports → Customer report → CSV (all customers + prospects; ~918 rows last time).
2. **Vehicles** — no vehicle report exists; vehicles appear on RO/invoice exports. Note this gap; nothing else to do.
3. **Repair orders / work orders** — RO/job report, full date range (account start → today), CSV.
4. **Invoices + payments** — invoice/sales report, full date range, CSV (cross-check: last AutoLeap invoice #100886, 2026-09-25).
5. **Estimates** (open + historical) — CSV if offered.
6. **Appointments** — calendar/appointment report, full history, CSV (confirms none are upcoming).
7. **Customer notes / inspections (DVI) / photos** — export or PDF any that matter; spot-check 3 recent customers.
8. **Message history** (texts/emails sent by AutoLeap) — export if offered; otherwise screenshot the settings showing
   automated reminders so you know what customers used to receive.
9. **Settings to record** — labor rates, canned jobs/service list + prices, tax settings (reference only).
10. **Integrations** — note the QuickBooks connection; **disconnect AutoLeap from QuickBooks only at cancellation**, after
    confirming no sync is pending, so it cannot write to QB again.
11. **Online booking link** `myalp.io/bhhjcb` — confirm 0 website references and Google switched before cancelling.
12. **Billing** — note renewal date + cancellation terms; download past AutoLeap bills.
