# Appointments — the AutoLeap booking replacement

Status (2026-10-19): **deployed to production** (see "Production state"). Public booking is **OFF** until a
manager turns it on at `/appointments/settings`.

**The appointment time is the customer's drop-off time only** — not when work starts, not a bay, not a
technician. Capacity only spaces arrivals apart: one public customer per 15-minute time, no daily cap.

This module replaces the one AutoLeap function Pitt Stop still relied on day to day: the
**"Schedule a Drop-Off!" / Google "Book online"** link (`https://myalp.io/bhhjcb`). It is not a rebuild
of AutoLeap. Everything else in the retail flow already runs in Pitt Stop OS (see "Replacement matrix").

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
`/api/cron/appointment-notifications` daily). A notice is `sent` only when a provider accepted it. **No
transactional email provider is configured**, so today notices are recorded `not_configured` and the
appointment page says so. To turn email on: owner picks a provider; set `APPOINTMENT_EMAIL_PROVIDER=postmark`,
`POSTMARK_SERVER_TOKEN`, `APPOINTMENT_EMAIL_FROM` (authenticated sending domain), then staff can **Retry
customer messages**. SMS is not used (no approved A2P registration). Vehicle-ready and invoice messages
remain the existing QuickBooks invoice email.

## Security

Public surface = `/book`, `/book/a/<token>`, `/api/book/availability` (yes/no per time only),
`POST /api/book/appointments`, `/api/book/a/<token>/{cancel,ics}`. Everything else stays behind the employee
PIN (`/appointments/*` is in the proxy matcher) and manager role checks in each action. Private links are
an HMAC of the appointment id (`APPOINTMENT_TOKEN_SECRET`, falls back to `IDENTITY_SECRET`); only the hash is
stored. Server-side zod validation, honeypot field, 6 bookings/hour per connection. The dedicated host
`book.pittstopdetailandautosales.com` (when its DNS exists) serves only those routes — everything else 404.

## Files

`apps/appointments/` — `policy.ts` (pure rules), `db.ts` (atomic writes, reads), `checkin.ts`, `notify.ts`,
`attribution.ts`, `tokens.ts`, `public.ts`, `public-host.ts`, `schema.ts`; tests `*.test.ts`.
UI: `app/book/*` (public), `app/appointments/*` (staff). APIs: `app/api/book/*`,
`app/api/cron/appointment-notifications`. Migration `drizzle/migrations/manual/0058_appointments.sql`
(additive; 4 tables). `apps/directory/intake-customer.ts`: vehicle link now optional.

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

- Deployed: origin/main `9b15943` (guard + capacity model + module), Vercel `dpl_3ukYQNTdv1UKURFtYbco9BBrB94u`.
  Migration `0058` applied to production and re-run (no-op). Public booking **OFF** after the controlled test.
- Private links use `IDENTITY_SECRET` (no `APPOINTMENT_TOKEN_SECRET` set). Do **not** add or rotate a token
  secret later without accepting that every customer link already issued stops working.
- `book.pittstopdetailandautosales.com` is attached to the Vercel project. It needs ONE GoDaddy record:
  `CNAME  book  →  81bdb230ad447ccd.vercel-dns-017.com` (Vercel's recommended value for this project).
  After it resolves and HTTPS works, set `BOOKING_PUBLIC_BASE_URL=https://book.pittstopdetailandautosales.com`
  (only used in email links) and redeploy.
- Controlled test records (all on 2026-10-20, customer "ZZ Pitt Stop …", example.com email): PS-F8MFNS
  (checked in; its test Job SO-20261019-0005 soft-removed), PS-B3WTUR / PS-JC45FB / PS-QH9WPF / PS-DBY82N cancelled.

## Website links (verified 2026-10-19 from the sitemap)

All point to `https://myalp.io/bhhjcb` — **34 links on 15 pages**, not only home/pricing: home (3), pricing (5),
shop (5), detailing (4), about, contact, exterior-detailing, interior-detailing, mechanic-services (1 each),
ceramic-coating-college-station (2), and the 5 product pages ceramic-coating, full-detail, mini-detail,
premium-detail, pitt-stop-gift-card (2 each). The site is WordPress (Avada-based theme + WooCommerce), so one
database search-and-replace (e.g. Better Search Replace, dry run first, handles serialized theme options)
replaces every occurrence. Re-scan the sitemap afterwards; the count of `myalp.io` must be 0.

## Cutover runbook

1. Owner adds the GoDaddy CNAME above; verify `https://book.pittstopdetailandautosales.com/book` loads over
   HTTPS and the host serves only booking routes (internal pages 404).
2. Short controlled re-test on the booking domain (book → see it on `/appointments` → cancel).
3. In AutoLeap: list every appointment dated today or later (booked since 10/15) and re-enter each at
   `/appointments/new` with source **Moved from AutoLeap** + the AutoLeap number (a repeat entry is blocked).
4. Turn online booking ON at `/appointments/settings`.
5. Website: replace `https://myalp.io/bhhjcb` with `https://book.pittstopdetailandautosales.com/book?utm_source=website`
   everywhere (see above). Google Business Profile → Bookings / "Book online" link →
   `https://book.pittstopdetailandautosales.com/book?utm_source=gbp`; remove the AutoLeap link.
6. Verification period (5–10 business days): AutoLeap stays available but unused; each day record whether
   anyone had to open it and why. Export AutoLeap customer / appointment / RO reports before cancelling.
