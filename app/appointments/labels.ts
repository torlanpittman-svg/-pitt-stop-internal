import type { BadgeTone } from '@/app/components/ui/Badge'

export const STATUS_TONE: Record<string, BadgeTone> = { confirmed: 'brand', arrived: 'positive', cancelled: 'neutral', no_show: 'warn', declined: 'neutral' }
// 'declined' must read as BOTH facts: the customer attended AND the estimate was declined — never just "declined".
export const STATUS_LABEL: Record<string, string> = { confirmed: 'Confirmed', arrived: 'Checked in', cancelled: 'Cancelled', no_show: 'No-show', declined: 'Attended — estimate declined' }
export const SOURCE_LABEL: Record<string, string> = {
  website_booking: 'Online', phone: 'Phone', walk_in: 'Walk-in', facebook: 'Facebook', google_ads: 'Google Ads',
  marketing: 'Marketing', autoleap_import: 'AutoLeap import', other: 'Other',
}
