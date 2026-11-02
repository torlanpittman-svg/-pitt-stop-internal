# New-booking alerts (in-app + phone push) — handoff

**Status: implemented locally and verified by tests/build only. NOT pushed, NOT deployed, no
migration applied, no notification ever sent to a real device.** Phone delivery is unproven until
the acceptance test below is run on the owner's iPhone.

Branch: `feat/booking-push-alerts` in worktree `/Users/torlanpittman/Projects/.ps-worktrees/booking-push`,
based on `origin/main` = `6642999`, which is the commit Vercel production was serving when this was
written (verified via the Vercel API: `dpl_Eu7DKoN2eVjxbEYBsb7kAKUyAaYG`, READY, target production).

---

## 1. What it does

When a customer finishes booking online:

1. The appointment is saved exactly as before. **The booking statement itself is untouched by this
   feature** (`apps/appointments/` is byte-identical to production): the alert is recorded right
   after the booking commits, best-effort, so no notification table, bug or missing migration can
   fail, delay or undo a booking. If even that write is lost, the next dispatch recreates the alert
   from the appointment row.
2. Every manager/admin device that enrolled gets a **Web Push** notification. Tapping it opens
   `/appointments/<id>` — the existing appointment screen, still behind the PIN gate.
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
| `web-push.ts` | VAPID signing, aes128gcm encryption, `sendPush` + HTTP outcome mapping, `pushConfig()` |
| `web-push.test.ts` | RFC 8291 vector, VAPID JWT shape, outcome mapping (23 tests) |
| `schema.ts` | `staff_push_subscriptions`, `staff_alerts`, `staff_alert_deliveries` |
| `db.ts` | `recordNewBookingAlert`, fan-out, delivery, retry, revocation, test notification, problem reporting |
| `db.integration.test.ts` | the outbox against real Postgres via PGlite + the real migrations (30 tests) |

**New — elsewhere**
- `drizzle/migrations/manual/0068_staff_push_alerts.sql` — the three tables (additive only).
- `app/api/appointments/push/route.ts` — GET status / POST enrol / DELETE un-enrol.
- `app/api/appointments/push/test/route.ts` — one test notification to the caller's own device.
- `app/appointments/notifications/page.tsx` + `EnableNotifications.tsx` — the enable button and the
  iPhone install steps.
- `app/components/NewBookingAlert.tsx` — the in-app home-screen alert.
- `scripts/generate-vapid-keys.ts` — one-off key generation (read-only; prints, writes nothing).

**Changed**
- `app/api/book/appointments/route.ts` — records the alert after the booking commits, then delivers
  that one alert post-response via `after()`; `maxDuration = 60` so the post-response work is not
  torn down mid-send. **`apps/appointments/` is not modified at all.**
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

## 4. How duplicates are prevented

| Scenario | What stops a duplicate |
|---|---|
| Customer double-taps Book | Same `idempotency_key` → the booking is replayed, the alert's `dedupe_key` (`<appointmentId>:new_booking`) collides, no second alert. |
| Dispatch runs again (cron, next booking, manual) | Fan-out is claimed once via `fanned_out_at`; `staff_alert_deliveries` has `UNIQUE (alert_id, subscription_id)`. |
| Two workers at the same instant | Every state change is a conditional `UPDATE … WHERE status = 'pending'`; only the winner sends. |
| Push service retry after a lost response | A delivery that was claimed is never re-claimed; a `retry` outcome is re-queued with backoff, up to 5 attempts. |
| Same phone re-enrolled | Keyed on `endpoint_hash` with upsert — one row per device, re-pointed at whoever enrolled last. |
| A device enrolled after the booking | Fan-out happens once, to the devices enrolled at that moment; it never back-fills old alerts onto a new phone. |
| An alert nobody received for a day | Retired `expired_unsent` instead of buzzing phones about stale news. |
| A worker crashed mid-send | The stale `claimed_at` is requeued (within the attempt limit) rather than losing the alert. A phone that already received the first attempt **replaces** that notification instead of stacking another, because both carry the alert id as their `tag`. |
| Turning notifications on for the first time | The recovery query only alerts bookings newer than the oldest enrolled device, so enabling a phone never replays the last day of bookings onto it. |
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
5. **Decide about hourly retries (owner decision).** `.github/workflows/booking-follow-ups.yml`
   already exists and is scheduled hourly, but it is **INERT** until two repository settings are
   added (GitHub → Settings → Secrets and variables → Actions):
   - secret `CRON_SECRET` = the same value as the Vercel project's `CRON_SECRET`
   - variable `BOOKING_CRON_BASE_URL` = `https://pitt-stop-internal.vercel.app`

   Without them the only retry pass is the **daily** Vercel cron at 22:00 UTC, and an alert that
   fails late in the day may age out (`MAX_ALERT_AGE_HOURS = 24`) before its second chance. This is
   less serious than it sounds, because the first attempt is immediate and the push services
   themselves hold a message for an offline or sleeping phone for up to the 24 h TTL — our retry only
   covers the case where the push service erred or the function died. Enabling those two settings
   also improves the existing unfinished-booking follow-ups, which have the same limitation.
6. **Phone acceptance test** — section 7.

**Rollback:** remove `VAPID_PRIVATE_KEY` from the environment. Push delivery stops immediately
(alerts are still recorded and the in-app banner still works); no code change or redeploy needed.
A full code rollback is the previous production deployment. Migration 0068 can also be rolled back
while this code is live (the three tables are referenced only by this feature), though there is no
reason to: without the keys they are inert.

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
   should arrive late (the push service holds it) and must appear **once**, not twice.

**Until step 6 passes on the device, phone delivery is unverified.** A push accepted by Apple is not
proof that a phone displayed it.

---

## 8. What was actually verified locally

- `apps/staff-alerts` — 53 tests pass (2 files), including the official RFC 8291 §5 vector and the
  outbox against real Postgres (PGlite) running the real migrations. One test renames `staff_alerts`
  out from under a booking to prove the booking still succeeds without the table.
- `apps/appointments` — 152 tests pass (8 files), with those files **unmodified**.
- Full suite `npm test` — 225 files / 2,883 tests, all passing (run because this touches shared code:
  `drizzle/schema.ts`, `proxy.ts`, and two cron routes).
- `npx tsc --noEmit` — no new errors (`apps/estimates/quickbooks.test.ts` errors are pre-existing on
  `origin/main` and untouched).
- `npx eslint` on every changed/new file — clean (`IdentityBar.tsx`'s two errors and
  `api/cron/finance-sync`'s one are pre-existing on `origin/main`).
- `npx next build --webpack` — compiled successfully; `/api/appointments/push`,
  `/api/appointments/push/test` and `/appointments/notifications` are in the route manifest.

**Not verified:** anything on a real device or against a real push service, and anything in
production. No key was generated, no environment variable set, no migration applied, no notification
sent, nothing pushed or deployed.

---

## 9. Follow-ups worth a decision later

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
