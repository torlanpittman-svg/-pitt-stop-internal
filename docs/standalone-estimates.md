# Standalone estimates

Managers can open **Estimates** from the home screen, capture a customer and vehicle, and price services with the existing estimate editor. The customer preview includes the same shop supplies, payment charge, and tax amounts used by the existing billing engine.

**Send estimate through QuickBooks** shows the recipient and total before sending. It creates/updates a QuickBooks Estimate, with separate linkage from retail invoices. The estimate remains off the Work Board. When the customer returns, **Move to Work Board** confirms approval of all listed services and moves the same record to Arrived. Contacts, pricing, notes, services, and the QuickBooks estimate reference are retained. The normal job and invoice workflow then applies. Converted estimates remain available through the history checkbox.

## Release

1. Apply `drizzle/migrations/manual/0041_standalone_estimates.sql` to the target database before deploying this code. It adds only `estimate_intakes`; it does not rewrite existing jobs. The statement is `CREATE TABLE IF NOT EXISTS`, so it is safe to re-run even where the table already exists.
2. Deploy the app using the existing Vercel deployment process. The existing `ESTIMATE_LAYER_ENABLED` setting must be enabled, and the user must have a signed manager/admin identity.
3. Verify a draft, price edit, and board conversion in a nonproduction database. Verify QuickBooks Estimate creation and send against a sandbox company and controlled recipient before using live customer email.

Released on September 16, 2026 at https://pitt-stop-internal.vercel.app/estimates.

The `estimate_intakes` table was applied to the verified production database during the September 16, 2026 release, and Vercel deployment `dpl_iCPQrXaoRP56LyC9o4GnFJdVMgiW` was aliased to the production domain. The existing estimate feature setting is enabled and the production QuickBooks connection is active.

> **Regression (September 17, 2026).** The September 16 release was deployed from the working tree without committing the code to git. The subsequent receipt/Expenses release deployed `origin/main` at commit `769babb`, which never contained the standalone-estimates code, so the homepage **Estimates** button, `/estimates` page, `/api/estimates` routes, and the `estimate_intakes` schema export disappeared from the live app. This work has now been committed on top of the receipt release. The migration was renumbered `0038 → 0041` because the receipt release claimed `0038`/`0039`/`0040`; the production `estimate_intakes` table already exists, so re-applying `0041` (idempotent) is a no-op there.

## Integrity

- Estimate-only orders use `status='estimate'` and have no arrival/completion timestamps. Board queries and active-vehicle duplicate checks exclude them.
- Intake creation uses one atomic database batch with an idempotency key. Conversion uses one SQL statement, conditional on estimate status, to update the job, service approvals, estimate decision, and audit trail together.
- Pricing, customer contact, send, and conversion actions share a per-intake lock. An interrupted lock expires after ten minutes. Preview revisions reject stale send/conversion requests.
- QuickBooks writes target `/estimate`, not `/invoice`. Create payloads are persisted before the first request. Stable request IDs recover ambiguous create/update/send results; unchanged versions are not emailed again.
- Customer identity, estimate identity, content, recipient, and total are checked before email. Tax-review/tax-bearing estimates are blocked by the current retail-only QuickBooks payload implementation.
- A QuickBooks estimate is retained as a quote; the later normal invoice workflow creates its own invoice. This release does not add a QuickBooks `LinkedTxn` conversion between the two.

## Validation

- All 570 tests passed, including 14 estimate-specific tests for board isolation, status transitions, identity checks, content drift, stale previews, and create/send retries.
- Production build, TypeScript, changed-file lint, and whitespace checks passed.
- Actual UI components were inspected using fixture data at 390px and 1440px widths. Intake, total/recipient preview, and conversion confirmation had no horizontal overflow. Temporary preview routes were removed.
- All 14 live production checks passed using a clearly labeled temporary fixture: manager page, anonymous access rejection, intake/retry, board exclusion, pricing/fees, conversion/retry, exactly one board record, retained customer/services/total, and one conversion event. The fixture and associated vehicle/contact were removed afterward.
- Actual QuickBooks sandbox checks passed for estimate creation, identity, line content, exact total, duplicate-request recovery, and update in place. The temporary sandbox estimate was deleted.
- Production QuickBooks company-profile connectivity was verified read-only. No customer emails were sent; actual email delivery was not exercised.
- Reusable live smoke test: `scripts/verify-standalone-estimates-live.mjs` (requires the local database configuration and existing admin password file). It never writes QuickBooks or sends email.

QuickBooks API reference: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/estimate

## Vehicle information update — September 17, 2026

The estimate editor now shows the full stored VIN (selectable for copying), vehicle description, color, license plate, and body style when available. Missing values are labeled Not recorded. These fields are read directly from the existing vehicle record, so a quote does not need to be moved onto the Work Board to inspect its vehicle information.
