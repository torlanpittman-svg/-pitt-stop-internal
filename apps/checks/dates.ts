/**
 * Business dates for checks. The shop runs on US Central time, so "today" on a check (and in QuickBooks)
 * is the Central calendar date — never the server's UTC date, which rolls over at 6–7 pm Central.
 */
export const BUSINESS_TIME_ZONE = 'America/Chicago'

/** YYYY-MM-DD for `now` in the business time zone. */
export function businessDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
