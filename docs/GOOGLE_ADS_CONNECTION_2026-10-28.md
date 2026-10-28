# Google Ads READ-ONLY reporting connection — 2026-10-28

Status: **implemented LOCALLY, not deployed.** The coordinator independently verified a LIVE read
against account `6843748548` (Google Ads API v26 `searchStream`) during setup. In this checkout the
wiring + tests are local only — no live report fetch, no credentials, and no deploy happen here. This
doc does not claim tests/lint/types ran (the coordinator runs those). No source attribution/payment
validation exists yet.

## What this adds

A read-only Google Ads reporting connection for the Marketing module. When validly configured, the
overview, weekly report, and Google Ads page pull **live** campaign metrics from the API; when no
reporting env is set they keep using the existing **manually-entered** `marketing_ad_metrics` rows.
Live and manual data are mutually exclusive — never combined, never double-counted.

There are **no writes**: no mutate endpoints, no campaign/budget changes, no DB writes, no migrations.

## Auth model (no developer token)

Google sunset developer tokens on 2026-09-09, so none is used. A Google Cloud **service account** with
read-only access to the Ads account is authorized via an OAuth 2.0 **JWT bearer grant**:

1. Sign an RS256 JWT with the service-account private key — `iss` = client_email,
   `aud` = the **pinned** token endpoint, `scope` = `.../auth/adwords`, `iat`/`exp = iat + 3600`.
2. Exchange it at the pinned `https://oauth2.googleapis.com/token`
   (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) for an access token.
3. Call `https://googleads.googleapis.com/<version>/customers/<id>/googleAds:searchStream` with
   `Authorization: Bearer <token>` (and `login-customer-id` only if a manager id is configured).

### Credential-request boundaries (hardened)
- The OAuth token endpoint **and** the JWT `aud` are **pinned** to `https://oauth2.googleapis.com/token`.
  A service-account JSON that supplies a different `token_uri` is **rejected** (`config_bad_token_uri`)
  — a supplied value can never steer the credential-bearing request.
- The Ads host is fixed; only the validated `vNN` version and numeric customer id vary in the path.
- Credential-bearing requests use `redirect: 'error'` so a 3xx cannot bounce the bearer token away.
- Server-only: key material is read from env and never logged, returned, embedded in an error, or used
  as a visible cache key.

Official references:
- https://developers.google.com/google-ads/api/docs/oauth/service-accounts
- https://developers.google.com/google-ads/api/docs/api-policy/developer-token

## Config: absent vs invalid vs configured

`resolveGoogleAdsConfig(env)` returns one of three states — this distinction is the core of the honesty
model:

- **absent** — NONE of the reporting env vars are set → use manually-entered data (`status: 'manual'`).
- **invalid** — some reporting env is present but malformed/partial → `status: 'unavailable'`,
  `errorKind: 'config'`. **No manual read, no fetch.** A misconfiguration never masquerades as manual
  data or as `$0`. Surfaced in Settings as a "Config error" with the sanitized `config_*` code.
- **configured** — all present pieces valid → live fetch is attempted.

Strict validation (all-or-nothing, no silent coercion):
- **Customer / login id:** 10 digits, only the documented `-`/space separators; arbitrary letters are
  rejected (not stripped).
- **API version:** must be `vNN`; absent → defaults to `v26`; present-but-bad → invalid.
- **Category map:** every key must be a numeric campaign id and every value a canonical service
  category, else the whole map is invalid (no partial drop).
- **Service account:** valid JSON, `client_email`, a loadable `private_key` (validated via
  `createPrivateKey`, never logged), and `token_uri` (if present) equal to the pinned endpoint.

## Server environment variables (never in the browser, never logged)

| Var | Required | Meaning |
|---|---|---|
| `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` | yes | Service-account key JSON (existing authorized read-only identity; contains `client_email` + `private_key`). |
| `GOOGLE_ADS_CUSTOMER_ID` | yes | `6843748548` (10 digits; `-`/space separators allowed). |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | optional | Manager (MCC) id — set ONLY if the account is actually reached via a manager. |
| `GOOGLE_ADS_API_VERSION` | optional | Defaults to `v26`. |
| `GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON` | optional | Explicitly-approved `{ "<campaignId>": "<serviceCategory>" }` map. |

## Dates, timezone, freshness

- The Google Ads account operates in **America/Chicago**. The overview + Google Ads page build a
  **month-to-date** window directly in that timezone (`apps/marketing/ad-dates.ts`), so the QUERIED
  range equals the DISPLAYED range and a UTC rollover can't shift the month/day (e.g. Nov 1 00:30 UTC
  is still Oct 31 in Chicago).
- **Shop/ad period alignment (overview):** the overview now bounds the SHOP timestamp window with the
  UTC instants of Chicago local midnight→end-of-day (`accountLocalPeriodToUtc`, DST-correct — spring
  forward and fall-back verified), and passes the account-local date strings to Google explicitly
  (`marketingReport({ adRange, basis: 'account_local' })`). So both the shop totals and the Google
  figures cover the *same* America/Chicago calendar days — the advertised period is literally what
  both query. The old code filtered shop timestamps on UTC midnight (≈5h early) while labeling the
  range Chicago; that drift is fixed.
- **Weekly/custom reports** keep their existing UTC day boundaries for the shop side and interpret the
  same date strings in the account timezone for Google (`periodBasis: 'utc'`). This basis is now
  surfaced on `MarketingReport.periodBasis` and the weekly page prints an explicit caveat that the two
  bases can differ by a few hours near midnight — no silent "one period" claim. (Not rewritten; only
  labeled honestly.)
- The live fetch validates the account's returned timezone shape and flags a mismatch vs
  America/Chicago (`GoogleAdsAccount.timeZoneMismatch`), disclosed in the banner.
- Freshness is rendered with an explicit timezone abbreviation (e.g. "… CDT").

## Units + recommendations (honest labels)

- Google **"conversion value"** is a Google-ASSIGNED value, shown as a **neutral number** (fractional
  units) — never dollars, never "revenue". `revenueCents` is retained only as internal compatibility.
- The Google ratio is labeled **"value ÷ spend"**, not ROAS.
- The report's per-service **"Rev ÷ spend"** (shop-invoiced ÷ Google spend) is a **cross-channel**
  ratio, explicitly **not** a verified Google-attributed ROAS; its budget directive is suppressed and
  replaced with a qualified observation.
- `buildAdRecommendations({ source: 'live' })` **suppresses** revenue/budget/underperformer advice from
  live assigned values; only manual search-term (negative-keyword) suggestions remain, and they are
  clearly labeled as manual (not synced).
- No assertion of collected/paid revenue — it is untracked.

## Response validation + errors

- One deadline covers the request **and** a bounded body read (streamed, byte-capped + row-capped); a
  slow body can't hang. Non-OK → `..._http_<status>`; parse failure/wrong shape → malformed.
- Metrics: an OMITTED field is a proto3 zero; a PRESENT null/`''`/boolean/non-finite/negative is
  rejected. cost/impressions/clicks must be safe non-negative integers; conversions + conversion value
  may be fractional. Aggregates are re-bounds-checked. Campaign id must be numeric; `segments.date`
  must be a real date within the requested range.
- `loadAdReporting` classifies failures: **401/403 → auth** and **config_\*/currency/customer →
  config** (both "needs setup attention", no "clears itself"); **429 → quota** (rate-limited, no
  automatic retries); everything else → **transient** (reload shortly). Errors are sanitized codes —
  no raw Google body.

## Caching

Per-instance, success-only, ~5-minute cache with concurrent-request coalescing, keyed by a SHA-256
**fingerprint of the full config** (service-account identity + private key [so a key rotation busts the
cache] + sorted category map + ids + version) plus the range. The raw key/JWT never appear in a key.
A failed fetch is never cached (the next call retries); a configured outage is never cached as `$0`.
The clock is milliseconds everywhere (cache TTL and JWT `iat` derive from the same `now`).

## Honest unavailable UI

- A configured-but-failing read is shown as **Unavailable**, never `$0`; `isEmpty` is false when ad
  data is unknown (the report never says "no activity"), and the Google Ads channel row is preserved
  (spend shown as unavailable, not dropped).
- **Recommended-action copy is cause-specific when unavailable.** The weekly/custom report's
  "Recommended action" no longer says "Run a campaign…"/"Import Google Ads data…" when Google data is
  unavailable; it uses `unavailableAdGuidance(errorKind)` — config → fix connection settings (a
  campaign/import won't resolve it), auth → reconnect (won't clear on its own), quota → returns on its
  own, transient → reload. The budget-shift observation is also suppressed when unavailable (no scored
  services). Live/manual states keep their normal "run a campaign"/"import" guidance.
- No "usually clears itself" advice for a configuration/auth error.
- Role/feature gates (`requireMarketingManager`) run **before** any fetch. No credentials reach the
  browser bundle.

## Files

- `apps/marketing/providers/google-ads.ts` (+ `.test.ts`) — config resolution/validation, pinned JWT,
  token exchange, bounded `searchStream`, metric validation, `fetchGoogleAdsReporting`, fingerprint.
- `apps/marketing/ads-reporting.ts` (+ `.test.ts`) — `loadAdReporting` provenance + error classification
  + success cache/coalescing (`AdDataMeta` gains `errorKind`).
- `apps/marketing/ad-dates.ts` (+ `.test.ts`) — account-local date helpers.
- `apps/marketing/ad-notice.ts` (+ `.test.ts`) — pure banner copy/severity for every state.
- `apps/marketing/ads.ts` — `CategoryAdRollup.conversionValue?` (raw assigned value).
- `apps/marketing/recommendations.ts` (+ `.test.ts`) — `source: 'live'` suppression.
- `apps/marketing/report.ts` (+ `report.ad-states.test.ts`) — honest `isEmpty`/`byChannel`/null money.
- `apps/marketing/providers/index.ts` — `ProviderStatus.googleAds = { state, error }`.
- `app/marketing/AdDataNotice.tsx`, `app/marketing/{page,report/page,google-ads/page,settings/page}.tsx`.

## Production prerequisites (NOT provisioned in this task)

- Destination: **Pitt Stop Internal** Vercel project `prj_0IrwBtr7GKX9a0Knn69gr8bvRzYc` / production.
- Set `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` (existing authorized read-only identity — no new key/identity,
  no broader access) and `GOOGLE_ADS_CUSTOMER_ID=6843748548`. `GOOGLE_ADS_API_VERSION=v26` is the
  default. Set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` only if actually required; set an
  explicitly-approved `GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON` only if/when approved.
- No values are provisioned here. Enabling in production is a separate, owner-approved step; verify the
  live read on `/marketing/google-ads` after setting env.

## Limitations

- Not deployed; no env provisioned; live behavior unverified in THIS checkout.
- Cache is per-instance, best-effort (serverless instances may not share it).
- Single account, single currency (USD) assumption — a non-USD account is rejected, not converted.
- No automated search-term sync (intentionally manual); no source attribution/payment validation yet.
- **Period alignment:** the OVERVIEW now shares one America/Chicago period across shop + ad figures.
  WEEKLY/custom reports still use UTC day boundaries on the shop side (`periodBasis: 'utc'`) and only
  label the few-hours-near-midnight difference — they are not re-aligned to account-local days (that
  would be a broader reporting-boundary rewrite, out of scope here).
- The 5-minute cache is not a global daily-quota limiter.
