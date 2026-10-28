/**
 * Pure presentation logic for the Google Ads provenance banner. Kept out of the .tsx so the exact
 * copy + severity for every data state is unit-testable (no rendering harness needed).
 *
 * The honesty rules this encodes:
 *   • live      → status note; "conversion value" is Google-assigned, NOT invoiced/collected revenue.
 *   • manual    → the figures are manually entered; shows how to connect the API.
 *   • unavailable → an ALERT whose copy depends on WHY:
 *       - config : needs SETUP attention (never "clears itself").
 *       - auth   : connection/permission needs attention (setup), not a transient blip.
 *       - quota  : rate-limited; no automatic burst retries; returns on its own later.
 *       - transient: temporary; reload shortly.
 *     Ad spend/ROAS are hidden (never invented) and shop data is explicitly unaffected.
 */
import type { AdDataMeta, AdErrorKind } from './ads-reporting'
import { ACCOUNT_TIME_ZONE, formatFetchedAt } from './ad-dates'

export interface AdNoticeContent {
  role: 'status' | 'alert'
  tone: 'live' | 'manual' | 'warn'
  heading: string
  body: string
}

const REASON: Record<string, string> = {
  // config
  config_missing_service_account: 'the service-account credential is not set',
  config_missing_customer_id: 'the customer id is not set',
  config_bad_customer_id: 'the customer id is not a valid 10-digit Google Ads id',
  config_bad_login_customer_id: 'the login (manager) customer id is invalid',
  config_bad_api_version: 'the configured API version is invalid',
  config_bad_category_map: 'the campaign-to-category mapping is invalid',
  config_bad_service_account_json: 'the service-account credential is not valid JSON',
  config_bad_service_account_shape: 'the service-account credential is missing required fields',
  config_bad_private_key: 'the service-account private key is invalid',
  config_bad_token_uri: 'the service-account token endpoint is not the expected Google endpoint',
  // account/config-level API responses
  google_ads_customer_mismatch: 'the connected account did not match the configured customer id',
  google_ads_unsupported_currency: 'the account currency is not USD (currencies are never combined)',
  // transient / upstream
  google_ads_timeout: 'the request to Google timed out',
  google_ads_network_error: 'Google Ads could not be reached',
  google_ads_token_network_error: 'Google could not be reached to sign in',
  google_ads_token_missing: 'Google did not return an access token',
  google_ads_malformed_response: 'Google returned an unexpected response',
  google_ads_response_too_large: 'Google returned an unexpectedly large response',
  google_ads_bad_metric: 'Google returned an invalid metric value',
}
function reasonText(code: string | null): string {
  if (!code) return 'the data could not be loaded'
  if (REASON[code]) return REASON[code]
  if (/_http_401$|_http_403$/.test(code)) return 'access was denied (permission or credentials)'
  if (/_http_429$/.test(code)) return 'Google temporarily rate-limited the request'
  if (/_http_5\d\d$/.test(code)) return 'Google Ads had a server error'
  return 'the data could not be loaded'
}

/**
 * Truthful "recommended action" line for a report whose Google Ads data is UNAVAILABLE. It NEVER
 * tells the owner to launch a campaign or import metrics (that cannot resolve an outage/misconfig and
 * would be misleading). Guidance matches the cause.
 */
export function unavailableAdGuidance(kind: AdErrorKind | null): string {
  switch (kind) {
    case 'config':
      return 'Google Ads is misconfigured, so ad figures are hidden — a manager needs to fix the connection settings. No reporting action on this page will resolve it.'
    case 'auth':
      return 'Google Ads access needs attention (permission or credentials) — reconnect the account. This will not clear on its own.'
    case 'quota':
      return 'Google Ads is temporarily rate-limited — the figures will return on their own once quota frees up. No action is needed.'
    default:
      return 'Google Ads data is temporarily unavailable — reload in a minute. Shop job and lead figures above are unaffected.'
  }
}

export function adNoticeContent(meta: AdDataMeta): AdNoticeContent {
  if (meta.status === 'live') {
    const acct = meta.account
    const who = acct ? `${acct.name ? `${acct.name} · ` : ''}#${acct.customerId} · ${acct.currency}` : 'account'
    const when = formatFetchedAt(meta.fetchedAt)
    const mismatch = acct?.timeZoneMismatch && acct.timeZone
      ? ` Account timezone is ${acct.timeZone}; dates are shown in ${ACCOUNT_TIME_ZONE} time.`
      : ''
    return {
      role: 'status',
      tone: 'live',
      heading: 'Google Ads connected (read-only)',
      body: `${who}.${when ? ` Fetched ${when}.` : ''} These are Google's own reported platform metrics — ` +
        `"conversion value" is a Google-assigned value, not Pitt Stop invoiced or collected revenue, and ad ` +
        `conversions are not completed jobs.${mismatch}`,
    }
  }

  if (meta.status === 'unavailable') {
    const kind = meta.errorKind
    const reason = reasonText(meta.error)
    if (kind === 'config') {
      return {
        role: 'alert', tone: 'warn',
        heading: 'Google Ads needs configuration',
        body: `${reason}. This needs setup attention — no ad figures are shown until it is fixed. Shop job and lead data is unaffected.`,
      }
    }
    if (kind === 'auth') {
      return {
        role: 'alert', tone: 'warn',
        heading: 'Google Ads connection needs attention',
        body: `${reason}. Ad figures are hidden until access is restored (this will not clear on its own). Shop job and lead data is unaffected.`,
      }
    }
    if (kind === 'quota') {
      return {
        role: 'alert', tone: 'warn',
        heading: 'Google Ads is rate-limited',
        body: `${reason}. There are no automatic retries; ad figures will return once Google quota frees up. Shop job and lead data is unaffected.`,
      }
    }
    return {
      role: 'alert', tone: 'warn',
      heading: 'Google Ads data is temporarily unavailable',
      body: `${reason}. Ad spend and ROAS are not shown (no figures are invented); shop job and lead data is unaffected — reload in a minute.`,
    }
  }

  return {
    role: 'status', tone: 'manual',
    heading: 'Google Ads API not connected',
    body: 'the ad figures shown are entered manually. Set GOOGLE_ADS_SERVICE_ACCOUNT_JSON + ' +
      'GOOGLE_ADS_CUSTOMER_ID in server env to enable read-only sync. Manual entries are the platform’s ' +
      'reported numbers, not Pitt Stop collected cash.',
  }
}
