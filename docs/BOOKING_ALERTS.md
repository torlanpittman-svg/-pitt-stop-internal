# New-booking alerts (in-app + phone push) — handoff

## Independent release verification — 2026-11-02

Codex reviewed the implementation and coordinated targeted fixes through Claude Code session
`f95f65b0-ce0e-48b8-9807-d54aef104f0b`, in the isolated `codex/booking-push-release` worktree.
Final verification: **228 test files / 2,953 tests pass**, and `next build --webpack` exits 0.
Standalone TypeScript output is identical to the production-source baseline (10 existing diagnostics
in `apps/estimates/quickbooks.test.ts`). Scoped ESLint has only the same two existing IdentityBar
diagnostics, independently reproduced against `origin/main`; no new diagnostics.
The original appointment domain, workflow, and QuickBooks modules are unchanged. Push-service
allowlisting, honest setup/disable states, explicit enrollment versus refresh, enrollment-time
filtering, queued-delivery ownership checks, post-response booking notification work, and the
dispatch time budget are covered by regression tests. The hourly customer-follow-up workflow and
its settings are unchanged. Real phone delivery remains unverified until the owner enables a device
and performs the acceptance test. The release is authorized; production outcome is recorded separately.

**Status: implemented and reviewed locally; verified by tests and a build only. No migration applied,
no notification ever sent to a real device.** Phone delivery is unproven until the acceptance test in
§7 is run on the owner's iPhone. A push accepted by Apple is not proof that a phone displayed it.

Release branch: `codex/booking-push-release`, built on commit `e13070d` plus the review fixes
recorded in §9. The feature was originally written on `feat/booking-push-alerts` off `origin/main` =
`6642999`, the commit Vercel production was serving at the time (verified via the Vercel API:
`dpl_Eu7DKoN2eVjxbEYBsb7kAKUyAaYG`, READY, target production). Confirm the current production commit
before deploying — this document's commit references age.

---

## 1. What it does

When a customer finishes booking online:

1. The appointment is saved exactly as before. **The booking statement itself is untouched by this
   feature** (`apps/appointments/` is byte-identical to production). The alert is recorded **after
   the customer's response has been sent**, from the route's `after()` callback — not on the
   response path — so no notification table, bug, stall, lock or missing migration can fail, delay
   or undo a booking. If that write is lost entirely (a dropped `after` callback), the next dispatch
   recreates the alert from the appointment row.
2. Every manager/admin device that was already enrolled **when that booking arrived** gets a **Web
   Push** notification. Tapping it opens `/appointments/<id>` — the existing appointment screen,
   still behind the PIN gate.
3. The Pitt Stop home screen shows an **in-app alert** ("New online booking → tap to open it") for
   as long as the booking is unacknowledged. This is the part that cannot fail: it reads the database
   on every Home render, whether or not any push got through.
4. The existing **"New online bookings" list and "Mark seen"** behaviour on `/appointments` is
   untouched. Acknowledgement is still what clears both the list and the home banner.

Notification text on the lock screen is deliberately bare:

> **New online booking**
> Drop-off Tue, Oct 20 at 9:00 AM. Tap to see the details.

No name, phone, email, vehicle or service list — those stay behind the PIN, on the screen the
notification opens.

### Explicitly NOT in this change
Website contact messages, a customer inbox, customer replies, customer appointment emails, SMS,
alerts for staff-entered phone/walk-in bookings, and alerts for anyone below manager.

---

## 2. No new service, subscription or Apple membership

Web Push is a browser standard. The server talks **directly** to the push service whose URL the
device itself hands over (Apple, Google, Mozilla), authenticating with a **VAPID keypair we generate
ourselves**. There is no account to create, nothing to register with Apple, no Apple Developer
membership, no email or SMS provider, and no new npm dependency: the VAPID JWT (RFC 8292) and the
`aes128gcm` payload encryption (RFC 8291) are implemented on `node:crypto` in
`apps/staff-alerts/web-push.ts`.

That implementation is verified against the **official RFC 8291 §5 test vector** — with the RFC's
sender key and salt injected, our output is byte-identical to the body published in the RFC
(`apps/staff-alerts/web-push.test.ts`). The private key only ever signs the request from the server;
it is never sent to a browser and never belongs in a `NEXT_PUBLIC_*` variable.

---

## 3. Files

**New — `apps/staff-alerts/`**
| File | Purpose |
|---|---|
| `web-push.ts` | VAPID signing, aes128gcm encryption, the **push-service allowlist**, `sendPush` + HTTP outcome mapping, `pushConfig()` |
| `web-push.test.ts` | RFC 8291 vector, VAPID JWT shape, outcome mapping, allowlist/SSRF cases (33 tests) |
| `schema.ts` | `staff_push_subscriptions`, `staff_alerts`, `staff_alert_deliveries` |
| `db.ts` | `recordNewBookingAlert`, fan-out, delivery, retry, revocation, test notification, problem reporting |
| `db.integration.test.ts` | the outbox against real Postgres via PGlite + the real migrations (38 tests) |

**New — elsewhere**
- `drizzle/migrations/manual/0068_staff_push_alerts.sql` — the three tables (additive only).
  `staff_push_subscriptions` has both `created_at` (audit: when the row first appeared, never
  rewritten) and `enrolled_at` (when the device's CURRENT enrolment began — the entitlement cut-off
  described in §4).
- `app/api/appointments/push/route.ts` — GET status / POST enrol / DELETE un-enrol.
- `app/api/appointments/push/test/route.ts` — one test notification to the caller's own device.
- `app/appointments/notifications/page.tsx` + `EnableNotifications.tsx` — the enable button and the
  iPhone install steps, plus `enrollment.ts` / `enrollment.test.ts` (18 tests): the enrol / status /
  stop plumbing, factored out so the honesty rules are testable without a DOM — the screen reports
  **ON only after the server confirms**, reports **off only when something verifiably stopped**, uses
  a **refresh-only** request for its automatic on-load re-registration, and bounds every wait so it
  can never be left saying "Checking this device…".
- `app/api/appointments/push/route.test.ts` — the two POST modes, the 409 refusal, and that
  authorization plus the endpoint allowlist run before any write in either mode.
- `app/components/NewBookingAlert.tsx` — the in-app home-screen alert.
- `scripts/generate-vapid-keys.ts` — one-off key generation (read-only; prints, writes nothing).

**Changed**
- `app/api/book/appointments/route.ts` — records **and** delivers that one alert entirely inside
  `after()`, i.e. after the customer's response; `maxDuration = 60` so the post-response work is not
  torn down mid-send. **`apps/appointments/` is not modified at all.** `route.test.ts` proves the
  booking response is produced before any alert work starts and that an alert write which throws, or
  never resolves at all, cannot delay or fail the booking.
- `app/api/cron/appointment-notifications/route.ts` (daily Vercel cron, 22:00 UTC) and
  `app/api/cron/booking-follow-ups/route.ts` (hourly **only if** the GitHub schedule is enabled —
  see §6 step 5) — the retry pass. A push failure here cannot fail the cron.
- `proxy.ts` — `/api/appointments/*` added to the employee-session gate (the public `/api/book/*`
  is untouched and stays open).
- `public/sw.js` — `push` + `notificationclick` handlers appended; the existing network-first
  navigation behaviour is unchanged.
- `app/page.tsx`, `app/appointments/page.tsx`, `app/components/IdentityBar.tsx` (sign-out releases
  the device), `drizzle/schema.ts`.
- `app/api/cron/booking-follow-ups/route.test.ts` — covers the new dispatch call and that a push
  failure still returns 200.

---

## 4. How duplicates and misdirected alerts are prevented

**What is actually guaranteed:** we never create a second *delivery* for the same (alert, device)
pair, and we never *send* twice for one delivery. **What is NOT guaranteed, by anyone:** exactly one
notification *displayed* on a phone. The notification carries the alert id as its `tag` / `Topic`,
which makes a push service replace an undelivered earlier copy and makes the OS replace a shown one,
and that removes the ordinary duplicate — but what a given iOS/Android version does with a replaced
notification is the OS's decision, not ours. Treat §7 step 8 as an observation, not a promise.

| Scenario | What stops a duplicate / a misdirected alert |
|---|---|
| Customer double-taps Book | Same `idempotency_key` → the booking is replayed, the alert's `dedupe_key` (`<appointmentId>:new_booking`) collides, no second alert. |
| Dispatch runs again (cron, next booking, manual) | Fan-out is claimed once via `fanned_out_at`; `staff_alert_deliveries` has `UNIQUE (alert_id, subscription_id)`. |
| Two workers at the same instant | Every state change is a conditional `UPDATE … WHERE status = 'pending'`; only the winner sends. |
| Push service retry after a lost response | A delivery that was claimed is never re-claimed; a `retry` outcome is re-queued with backoff, up to 5 attempts. |
| Same phone re-enrolled | Keyed on `endpoint_hash` with upsert — one row per device, re-pointed at whoever enrolled last. |
| A device enrolled after the booking | `enrolled_at` is the cut-off: a delivery is only ever created where `enrolled_at <= the APPOINTMENT's created_at`. Compared against the booking's own clock, never the alert's (a recovered alert is created hours later) and never "now". |
| A phone handed to a different person, or turned back on | That re-enrolment moves `enrolled_at` forward, so the new enrolment is not owed older bookings. A routine refresh by the same person (which the setup screen does on every visit) **preserves** it, so a phone that merely re-opened the app keeps the alerts it was already owed. |
| Opening the Notifications screen on a device somebody turned OFF | The screen's automatic re-registration is **refresh-only** (`mode: 'refresh'` → one conditional `UPDATE … WHERE still enabled AND still owned by this actor`). It cannot insert, re-enable or transfer, so a disabled device stays disabled and a colleague's device stays theirs; the screen shows "off" with the Enable button. Only an explicit Enable may change who or whether. |
| A phone that changes hands while a delivery is still queued | The entitlement is re-read and re-checked immediately before sending, so an already-queued delivery is `skipped` rather than sent to whoever holds the phone now. |
| An alert nobody received for a day | Retired `expired_unsent` instead of buzzing phones about stale news. |
| A worker crashed mid-send | The stale `claimed_at` is requeued (within the attempt limit) rather than losing the alert — losing an alert is worse than a possible second arrival, and the shared `tag` replaces the undelivered earlier copy. |
| A run that would overrun its invocation | A wall-clock budget stops the run before starting a send it has no time for; untouched deliveries stay `pending` with their attempts intact and go out on the next run. |
| Turning notifications on for the first time | The recovery query only creates an alert when some currently-enrolled device predates that booking, so enabling a phone never replays the last day of bookings onto it. |
| A booking staff already marked seen | The recovery query uses the same `acknowledged_at IS NULL` rule as the Appointments list. |

## 5. Who gets alerted, and how access is revoked

Manager/admin only (`EMPLOYEE_IDENTITIES` + the `ADMIN_PASSWORD` admin actor). Enrolment requires a
**strict** manager identity — an anonymous/legacy shared-PIN session cannot enrol a device.

- **Sign out** → the device's subscription is released (client) and disabled server-side
  (`signed_out`), so the next person on a shared shop phone does not inherit someone else's alerts.
- **Access revoked** (removed from `EMPLOYEE_IDENTITIES`, or demoted) → every dispatch re-checks the
  live registry first and disables that person's devices (`revoked`) *before* sending anything.
- **Subscription expired** (404/410 from the push service) → device disabled (`expired`) and its
  other queued alerts skipped, never retried.

Rows are only ever soft-disabled, so the enrolment history stays auditable.

**Where the server is allowed to send.** A subscription endpoint is a URL this server makes an
outbound POST to, so it is checked against one shared allowlist (`PUSH_PROVIDERS` in
`apps/staff-alerts/web-push.ts`): HTTPS only, on `push.apple.com` + subdomains, exactly
`fcm.googleapis.com`, `push.services.mozilla.com` + subdomains, or `notify.windows.com` +
subdomains. Userinfo, a non-default port, a fragment and suffix look-alikes (`evilpush.apple.com`,
`fcm.googleapis.com.evil.example`) are all refused, and redirects are not followed
(`redirect: 'error'`). The rule is enforced both at enrolment and again inside `sendPush` — the one
place a request is actually made — so no arbitrary DNS name or redirect can point the server at an
internal address, whatever is in the table. If a browser ever issues an endpoint on a host outside
that list, enrolment fails with "Unsupported push endpoint" and the host has to be added
deliberately.

---

## 6. Release steps (nothing below has been done)

**Order no longer matters for safety.** The booking statement does not reference the new tables, so
deploying before the migration cannot break online booking — booking alerts simply do not work until
the migration is applied (the recording call fails, is caught, and the booking is kept). Applying the
migration first is still the tidier order.

1. **Generate the keys** (once, locally — read-only, touches no database):
   ```
   cd /Users/torlanpittman/Projects/.ps-worktrees/booking-push
   npx tsx scripts/generate-vapid-keys.ts
   ```
2. **Set three production environment variables** (Vercel → pitt-stop-internal → Settings →
   Environment Variables, Production):
   - `VAPID_PUBLIC_KEY` — from step 1.
   - `VAPID_PRIVATE_KEY` — from step 1. Server-side only; never `NEXT_PUBLIC_*`.
   - `VAPID_SUBJECT` — `mailto:` address or `https:` URL the push services can use as a contact.

   Also add them to local `.env.local` if local testing is wanted. Until all three are set, bookings
   still save and still show in the app; devices simply cannot be enrolled and nothing is sent.
3. **Apply migration `0068_staff_push_alerts.sql` to the production Neon branch**
   (`ep-morning-base-adq5h6rq`). Additive only: three new tables, no existing table, column, index or
   row is touched. Renumber if another branch has taken 0068 in the meantime.
4. **Deploy** using the established pattern — cherry-pick this branch's commit into a worktree off
   current `origin/main`, fast-forward push, then confirm the deployed commit through the Vercel API
   (not public asset hashes).
5. **Retries are DAILY. Nothing in this release changes that, and nothing here activates an hourly
   schedule.** The only retry pass that runs is the **daily** Vercel cron
   (`/api/cron/appointment-notifications`). `/api/cron/booking-follow-ups` also runs the retry when
   it is called, and `.github/workflows/booking-follow-ups.yml` is scheduled hourly in the file —
   but that workflow is **INERT** and is **deliberately left inert**: it does nothing until two
   GitHub repository settings are added (Settings → Secrets and variables → Actions), which is a
   **separate owner decision and not part of this release**:
   - secret `CRON_SECRET` = the same value as the Vercel project's `CRON_SECRET`
   - variable `BOOKING_CRON_BASE_URL` = `https://pitt-stop-internal.vercel.app`

   Consequence of daily-only, stated plainly: an alert whose *first* attempt fails late in the day
   may age out (`MAX_ALERT_AGE_HOURS = 24`) before its second chance. That is narrower than it
   sounds — the first attempt is immediate, and the push services themselves hold a message for an
   offline or sleeping phone for up to the 24 h TTL, so our own retry only covers the case where the
   push service erred or the function died. The in-app Home banner is unaffected either way.

   Enabling those two settings would also affect the **existing customer-facing unfinished-booking
   follow-ups**, which share that endpoint. That is exactly why it is not being switched on here: no
   customer follow-up configuration is changed by this release.
6. **Phone acceptance test** — section 7.

**Rollback — read this before relying on it.**

- **The kill switch is a deployment, not an environment edit.** Removing or blanking
  `VAPID_PRIVATE_KEY` in Vercel does **not** take effect on the running app: environment variables
  are bound to a deployment, so the currently-running functions keep the value they were deployed
  with. **A new deployment (or a redeploy) is required before the change is live.** There is no
  instant env-only rollback.
- **The fast rollback is Vercel Instant Rollback to the previous production deployment.** That is a
  code rollback and it does take effect immediately.
- Once a deployment without the keys *is* live, push delivery stops while alerts are still recorded
  and the in-app Home banner still works — so staff keep seeing new bookings in the app.
- Migration 0068 can be rolled back while this code is live (the three tables are referenced only by
  this feature and never by the booking statement), though there is no reason to: without the keys
  they are inert. Dropping them while the code is live means the post-response alert write throws and
  is swallowed; bookings are unaffected.

---

## 7. Phone acceptance test (to be run on the owner's iPhone, with approval)

Nothing here has been done. Steps 4–7 send real notifications, but only to the owner's own device.

1. On the iPhone, open Pitt Stop in **Safari** and sign in with the manager PIN.
2. Share → **Add to Home Screen** → Add. (iOS 16.4+. Web Push is not available in a Safari tab, only
   in the installed app — the setup screen says so and detects it.)
3. Open Pitt Stop from the **Home Screen icon**, go to **Appointments → Notifications**. Expect
   "Notifications are off on this device" and an Enable button (not "server setup still needed", and
   not the install warning).
4. Tap **Enable notifications on this device** → **Allow**. Expect "Notifications are ON" and the
   device listed under "Your devices getting alerts".
5. Tap **Send a test notification**. Expect a notification within a few seconds. **Lock the phone
   and check the lock screen shows no customer name** — the test text is generic by design.
6. **Close the app completely** (swipe it away). On a computer, make ONE real booking through the
   public booking page using owner-controlled contact details (a test booking creates a real
   appointment — cancel it afterwards and note it as a test, as with previous test bookings).
   Expect: a notification on the locked iPhone showing only the drop-off time; tapping it opens the
   appointment screen for that booking.
7. Confirm the Pitt Stop home screen shows the in-app "New online booking" banner, that it links to
   the same appointment, and that **Mark seen** on `/appointments` clears both.
8. Repeat step 6 once with the phone in **Airplane Mode**, then turn Wi-Fi back on: the notification
   should arrive late, because the push service holds it. Note how many copies appear. Expect one —
   the shared `tag`/`Topic` replaces an undelivered earlier copy — but this is an **observation to
   record, not a guarantee**: we control how many messages we send, not what the OS displays. Two
   notifications for one booking is a cosmetic annoyance worth reporting, not a data problem.

**Until step 6 passes on the device, phone delivery is unverified.** A push accepted by Apple is not
proof that a phone displayed it.

---

## 8. What was actually verified locally

On the original `e13070d` implementation:

- Full suite `npm test` — 225 files / 2,883 tests, all passing (run because this touches shared code:
  `drizzle/schema.ts`, `proxy.ts`, and two cron routes).
- `apps/appointments` — 152 tests pass (8 files), with those files **unmodified**.
- `npx tsc --noEmit` — no new errors. The 10 errors in `apps/estimates/quickbooks.test.ts` are
  pre-existing on `origin/main`; that file is byte-identical here and was deliberately not touched.
- `npx eslint` on every changed/new file — clean (`IdentityBar.tsx`'s two errors and
  `api/cron/finance-sync`'s one are pre-existing on `origin/main`).

After the review fixes in §9:

- `apps/staff-alerts/web-push.test.ts` — **33 pass** (RFC 8291 §5 vector, VAPID JWT shape, outcome
  mapping, and the allowlist/SSRF cases).
- `apps/staff-alerts/db.integration.test.ts` — **38 pass** against real Postgres (PGlite) running the
  real migrations. One test renames `staff_alerts` out from under a booking to prove the booking
  still succeeds without the table.
- `app/appointments/notifications/enrollment.test.ts` — **18 pass**.
- `npx next build --webpack` — full success; `/api/appointments/push`, `/api/appointments/push/test`
  and `/appointments/notifications` are in the route manifest.

**Honest gaps in the verification, as of this document:**

- The **full suite has not been re-run** since the last round of fixes (the send-time enrolment
  re-check and the honest "off" path). The two directly affected files are covered by the counts
  above; `app/api/book/appointments/route.test.ts` and
  `app/api/cron/booking-follow-ups/route.test.ts` also need to be in that run. Re-run `npm test`
  before deploying — this change touches `drizzle/schema.ts` and two cron routes, which is squarely
  in CLAUDE.md's "run the full suite" category.
- **Nothing has been verified on a real device or against a real push service**, and nothing in
  production: no key generated, no environment variable set, no migration applied, no notification
  sent.
- The `enrollment.ts` rules are tested as functions. **The component wiring itself
  (`EnableNotifications.tsx`) has no test** — this project has no DOM test environment — so the
  mapping from those outcomes onto what the screen shows is verified by reading the code and by §7.

---

## 9. Review fixes applied on top of `e13070d`

Each of these was a real defect found in review, not a tidy-up:

1. **Push endpoints are allowlisted** (§5, "Where the server is allowed to send"). The original
   validation accepted any public-looking DNS name and `sendPush` followed redirects, so a stored or
   injected endpoint could have pointed the server at an internal address.
2. **The setup screen no longer claims "ON" without the server's confirmation.** The enrolment POST
   was fire-and-forget; a 403, a 503, a 500 or no connection still showed a green "Notifications are
   ON". Every wait on that screen is now bounded, so it also cannot be left on "Checking this
   device…". Permission is still requested as the first thing the user's tap does — Safari ignores a
   prompt that comes after an `await`.
3. **Turning a device OFF is now honest too.** A failed server release plus a failed browser
   unsubscribe used to be reported as "off" while the phone was still enrolled and reachable.
   Relatedly, the screen's automatic on-load re-registration is now **refresh-only**: it used to run
   the full enrol upsert, so opening the Notifications screen silently re-enabled a device somebody
   had turned off (the browser subscription survives a failed local unsubscribe) and silently
   transferred a colleague's device to whoever was signed in. Only an explicit Enable does that now.
4. **`enrolled_at` replaces `created_at` as the entitlement cut-off**, compared against the
   *appointment's* `created_at` at fan-out *and* re-checked against a fresh read immediately before
   sending. The original `CROSS JOIN` fanned every alert out to every enabled device, and recovery
   compared against the alert's own creation time, so a newly enabled phone could be alerted about
   older bookings and a phone that changed hands could receive the previous holder's booking.
5. **The dispatcher has a wall-clock budget.** A serial limit of 25–50 sends × an 8 s timeout can
   exceed the 60 s invocation; untouched deliveries now stay `pending` with their attempts intact
   instead of a run being torn down mid-send.
6. **This document** — the rollback claim, the retry cadence and the "appears exactly once" claim
   were all wrong; the migration's comments contradicted the implementation.

## 10. Follow-ups worth a decision later

- Alerts for staff-entered phone/walk-in bookings (deliberately excluded — they are entered by
  someone who already knows).
- Alerts for cancellations by customers through the manage link.
- Extending recipients below manager level.
- `public/manifest.json` icons are SVG; iOS prefers a 180×180 PNG `apple-touch-icon` for the Home
  Screen icon. It does not affect notification delivery, only how the installed icon looks.
- The "All enrolled devices" list on the Notifications screen shows every manager's device name (not
  addresses or keys) so a manager can see who is actually covered. Deliberate — say so if it should
  be scoped to the viewer instead.
- Disabling a device clears its live push credentials and keeps the audit row. The rows themselves
  are never purged; a retention rule for long-disabled devices is still an open decision.
- `docs/ARCHITECTURE_MAP.md` / `docs/DATA_FLOWS.md` exist on the `cleanup/usability-pass` branch, not
  on `origin/main`; add the `staff-alerts` module and the three tables there when that branch lands.
