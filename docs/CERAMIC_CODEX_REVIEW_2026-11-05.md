# Ceramic release — Codex review handoff (2026-11-05, second pass)

**Checkout:** `/private/tmp/pitt-ceramic-release-review`, branch `codex/ceramic-release-review` off `origin/main` (60c8c91),
cherry-picks `aa168dc`, `3b02586`, `4164373`, `2d65642` only. **All gift-card code and migration 0074 are HELD OUT** of this
release (see "Gift-card hold" below). Claude implemented the quote retry protection described here; **no commands were run
in that session** — Codex runs tests/tsc/lint and reviews before anything ships. The original `feat/ceramic-tracking`
branch is untouched.

## What changed: public quote retry protection

The review found `/api/quote` had no request idempotency (a retry/double-tap = second lead + second email), photos existed
only as email attachments (a failed send destroyed them), and `service in QUOTE_SERVICES` accepted inherited object keys
(`toString`, `__proto__`).

Design (reuses the appointment-outbox claim pattern and its delivery-certainty doctrine; no new email infrastructure,
no transactions required — the neon-http driver has none). **Reworked after Codex's second-pass finding** that the first
version created the lead in separate statements (an orphaned lead + a stale-takeover could duplicate leads/sends):

1. **Client request key** (`app/quote/QuoteForm.tsx`): minted at first submit (`crypto.randomUUID`, bounded fallback),
   REUSED while the content is unchanged, cleared on any edit or on a server-reported key conflict. UI unchanged otherwise.
2. **Atomic claim** (`apps/marketing/quote-request.ts` + new `quote_requests` table): ONE data-modifying-CTE statement
   creates the claim row (`ON CONFLICT (request_key) DO NOTHING`), the `marketing_leads` row AND the append-only
   `lead_created` audit event all-or-nothing — a failure in any of the three leaves nothing behind (regression-tested by
   injected triggers). IDs are generated client-side so the claim can carry `lead_id NOT NULL` from birth: a lead-less
   claim is impossible by schema, so **no recovery path ever guesses whether a lead exists, and the stale "null takeover"
   is gone entirely**. FK checks run at statement end, so the claim may reference the lead created in the next CTE.
   Photos are persisted in this same statement, BEFORE any email attempt.
3. **The send fence:** every provider send — including the creator's own first send — is authorized by winning a
   conditional UPDATE that advances `email_attempts` (0→1 while `processing` for the first send; +1 only from a recorded
   DEFINITE non-delivery for a retry). `processing`, `uncertain` and `sent` can never be fenced, so an in-flight,
   possibly-delivered or delivered email can never be sent again; a merely **delayed** owner that loses its fence follows
   the winner's outcome instead of sending. Outcomes are recorded only onto the sender's own token
   (`WHERE email_attempts = token AND email_status IN ('processing','uncertain')`), so a definite outcome can upgrade a
   watcher's `uncertain` marker but a stale sender can't clobber a newer attempt.
4. **Never-throws after the lead exists:** provider exceptions → recorded `uncertain` (what *might* have been accepted is
   never resent); a **DB failure while recording the outcome** is also caught — the caller still gets the true provider
   result plus a note, and the row stays `processing` at that token, a state nothing can fence (no resend possible) that a
   later replay resolves to `uncertain`. The route can no longer answer 500 ("unsaved") once the lead exists. The lead
   note says photos are *saved with the quote request*, never "emailed".
5. **Replay path (same key, same payload hash):** `sent`/`uncertain` return the stored outcome without sending;
   `failed`/`not_configured`/`blocked` re-fence (one winner) and try again; a reused key with a **different** payload hash
   is a 409 conflict, never another payload's result. Crash recovery: `processing` + `email_attempts = 0` + stale proves
   no send was ever authorized → fence and send once (reusing the existing lead); `processing` + `email_attempts > 0` +
   stale means a send may have gone out → marked `uncertain`, never resent.
6. **Prototype-key fix:** `Object.hasOwn` replaces `in` in `parseQuoteRequest` and the `/quote?service=` preselect.

### Files changed (all inside this checkout)

| File | Change |
|---|---|
| `drizzle/migrations/manual/0075_quote_requests.sql` | NEW — `quote_requests` claim/outbox table, `lead_id uuid NOT NULL REFERENCES marketing_leads(id)`. Additive, idempotent, **no reference to 0074**. |
| `apps/marketing/schema.ts` | NEW `quoteRequests` table (status IS updated — operational outbox; the lead_created audit in `marketing_events` stays append-only). |
| `apps/marketing/quote-request.ts` | `Object.hasOwn` fix; `normalizeRequestKey` / `quotePayloadHash`; atomic claim+lead+audit CTE (writes `marketing_leads`/`marketing_events` directly — `createLead` is bypassed, not modified); `email_attempts` send fence; never-throws send + outcome recording; honest lead note; `SubmitResult.replayed`. |
| `app/api/quote/route.ts` | Passes `requestKey`; maps `QuoteRequestConflictError` → 409 `{ conflict: true }` and `QuoteStillProcessingError` → 409 (neither claims the request was lost). |
| `app/quote/QuoteForm.tsx` | Request-key ref: mint on submit, clear on any payload edit / server conflict; key sent in the body. No UI redesign. |
| `app/quote/page.tsx` | `Object.hasOwn` for the `?service=` preselect. |
| `apps/marketing/quote-request.test.ts` | Unit tests: inherited service keys rejected; request-key normalization; payload-hash stability. |
| `apps/marketing/quote-request.integration.test.ts` | NEW PGlite test (migrations 0046 + 0072 + **0075**, 0075 re-run for idempotency): fresh submit persists photos before sending + honest note; successful replay (one send, one lead); concurrent duplicates → one provider call, same leadId; failed replay re-fences on the same lead; uncertain replay never re-sends; thrown provider → uncertain, lead still returned; payload mismatch → conflict; **all-or-nothing claim proven by injected trigger failures on the lead and audit inserts; crash-before-fence recovered with one send and no second lead (two concurrent retries); unrecorded fenced send → uncertain, never resent; delayed owner cannot double-send and its definite outcome upgrades the uncertain marker; outcome-recording DB failure returns the honest provider result and the stuck row resolves to uncertain with no resend.** |

No other test migration list needed 0075 (only this new test touches `quote_requests`). Analytics/consent, booking copy,
referral reporting and everything else in the four cherry-picked commits are unchanged.

## Migrations for this release

Apply **0071 → 0072 → 0073 → 0075** (as `neondb_owner` via `DATABASE_URL_OWNER`, prod branch `ep-morning-base-adq5h6rq`,
verify with `tsx scripts/db-target.ts` first). **0074 is reserved for gift cards and is NOT applied.** 0075 has no
dependency on it; the gap in numbering is deliberate.

## Gift-card hold (unchanged from the first review pass)

`5f1fbae` stays on `feat/ceramic-tracking` only. Confirmed defects to fix before it ships: the redeem
`INSERT … SELECT sum(...)` guard does not serialize across connections (READ COMMITTED snapshot race → overspend);
issue/void/adjust are multiple autocommit writes (double-void corrupts the ledger, adjust has no SQL guard at all);
no request idempotency; the single-connection PGlite `Promise.allSettled` test proves serial logic only. Recommended fix
direction: DB-enforced guard (trigger taking `FOR UPDATE` on the parent row, raising on negative sum / non-active card)
or a module-scoped session driver with real transactions, plus a request-key unique constraint like the one added here.
Zero cards have been issued; holding costs nothing.

## Remaining verification needs (Codex)

- Run: `npx vitest run apps/marketing app/quote` (new + existing), then `npx tsc --noEmit -p .`, `npx eslint` on the
  changed files, `npx next build --webpack`, and the full suite before deploy (new table in `drizzle/schema.ts` aggregate).
- **Not proven by tests:** true multi-connection concurrency (PGlite is one connection — the guarantee rests on the UNIQUE
  constraint, the single-statement CTE claim and the fence's conditional UPDATEs, which should be confirmed by review, not
  assumed from the suite). Review should also confirm the one Postgres-semantics assumption the atomic claim leans on:
  FK (RI) checks fire at END of statement, so the claim CTE may insert `lead_id` before the lead CTE inserts the lead
  (standard wCTE behavior; the PGlite tests exercise it with the real constraint in place).
- No route-level test exists for `/api/quote` (409 mapping is only reviewable by reading `route.ts`); worth adding later.
- Browser walkthrough of `/quote` (double-click submit, edit-after-failure) — no Playwright run in this session.
- Follow-ups, owner-visible but non-blocking: retention/cleanup policy for `quote_requests.photos` (rows accumulate
  ~0.1–2.7 MB each; harmless at expected volume), and a small staff surface to view stored photos when the email failed
  (today they are reachable only via SQL).
- Post-deploy §7.2 of `docs/CERAMIC_RELEASE_CODEX_HANDOFF_2026-11-05.md` (controlled Postmark end-to-end) still gates the
  WordPress links; §7.5 (gift cards) is dropped from this release.
