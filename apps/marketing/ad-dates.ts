/**
 * Account-local date helpers for Google Ads reporting.
 *
 * Google Ads reports in the ACCOUNT's local timezone, not UTC. Building the range in UTC near a
 * month/day boundary (e.g. Nov 1 00:30 UTC is still Oct 31 in Chicago) silently shifts the window and
 * makes the displayed range disagree with the queried range. These helpers compute YYYY-MM-DD strings
 * directly in the account timezone so the query range and the UI range always match.
 *
 * The Pitt Stop Google Ads account operates in America/Chicago (US Central). The live fetch also
 * validates the account's returned timezone and flags a mismatch (`GoogleAdsAccount.timeZoneMismatch`).
 */
export const ACCOUNT_TIME_ZONE = 'America/Chicago'

/** YYYY-MM-DD for `d` as seen in `tz` (default account tz). */
export function ymdInZone(d: Date, tz: string = ACCOUNT_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** First day of the month containing `now` (account-local): YYYY-MM-01. */
export function monthStartInZone(now: Date, tz: string = ACCOUNT_TIME_ZONE): string {
  return `${ymdInZone(now, tz).slice(0, 7)}-01`
}

/**
 * Month-to-date reporting window in the account timezone: { from: 1st of month, to: today }.
 * `from` and `to` are account-local YYYY-MM-DD so the queried range equals the displayed range.
 */
export function monthToDateRange(now: Date, tz: string = ACCOUNT_TIME_ZONE): { from: string; to: string } {
  return { from: monthStartInZone(now, tz), to: ymdInZone(now, tz) }
}

/**
 * The UTC instant for a wall-clock time (`YYYY-MM-DDTHH:mm:ss.sss`, no zone suffix) in `tz` — correct
 * across DST because the zone offset is measured AT the resolved instant. Two passes settle the offset
 * for spring-forward / fall-back transitions. This lets us turn an account-local calendar DAY into the
 * exact UTC boundary instants a timestamp column should be filtered on, instead of mislabeling a UTC
 * midnight as the local day start.
 */
export function zonedWallTimeToUtc(wall: string, tz: string = ACCOUNT_TIME_ZONE): Date {
  const wallMs = Date.parse(`${wall}Z`) // interpret the wall clock AS IF it were UTC
  const offsetAt = (instant: number): number => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant))
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value)
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
    // Compare at SECOND granularity on both sides — the formatted parts have no milliseconds, so
    // truncating `instant` too keeps the offset a clean whole-minute value (no sub-second drift that
    // would push a `…T23:59:59.999` boundary past local midnight).
    return asUtc - Math.floor(instant / 1000) * 1000
  }
  let utc = wallMs - offsetAt(wallMs)
  utc = wallMs - offsetAt(utc) // second pass: re-measure the offset at the candidate instant
  return new Date(utc)
}

/** First UTC instant of the account-local calendar day `ymd` (inclusive day start). */
export function accountLocalDayStartUtc(ymd: string, tz: string = ACCOUNT_TIME_ZONE): Date {
  return zonedWallTimeToUtc(`${ymd}T00:00:00.000`, tz)
}

/** Last UTC instant of the account-local calendar day `ymd` (inclusive day end, covers the whole day). */
export function accountLocalDayEndUtc(ymd: string, tz: string = ACCOUNT_TIME_ZONE): Date {
  return zonedWallTimeToUtc(`${ymd}T23:59:59.999`, tz)
}

/**
 * Turn an account-local YYYY-MM-DD period into the UTC Date instants that bound it inclusively, so a
 * shop timestamp filter (`completed_at >= from AND <= to`) covers exactly the same local days Google
 * reports for those same date strings.
 */
export function accountLocalPeriodToUtc(from: string, to: string, tz: string = ACCOUNT_TIME_ZONE): { from: Date; to: Date } {
  return { from: accountLocalDayStartUtc(from, tz), to: accountLocalDayEndUtc(to, tz) }
}

/**
 * Human freshness label with an EXPLICIT timezone, e.g. "Oct 28, 2026, 3:04 PM CDT". Returns '' for a
 * missing/invalid timestamp. Rendered in the account timezone so "fetched" time is unambiguous.
 */
export function formatFetchedAt(iso: string | null, tz: string = ACCOUNT_TIME_ZONE): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // NOTE: dateStyle/timeStyle cannot be combined with individual component options (incl.
  // timeZoneName) — that throws a RangeError. Use explicit components so we can keep an explicit
  // timezone abbreviation.
  return d.toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  })
}
