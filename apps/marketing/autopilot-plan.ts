/** The owner's standing cadence. Planning never sends or imports contacts. */
import { createHash } from 'node:crypto'
import { validateCopy } from './guardrails'
import type { ServiceCategory } from './types'

export const AUTOPILOT_POLICY = 'october-2026-v1'
export const SHOP_URL = 'https://www.pittstopdetailandautosales.com'
export const SHOP_PHONE = '979-696-6640'
export const SHOP_ADDRESS = '3112 Texas Avenue South, College Station, TX 77845, United States'
export type AutopilotChannel = 'email' | 'facebook'
export interface PlanSlot { key: string; id: string; channel: AutopilotChannel; date: string; topic: string; service: ServiceCategory; subject: string; body: string }

const TOPICS: Array<{ topic: string; service: ServiceCategory; subject: string; body: string }> = [
  { topic: 'Paint correction explained', service: 'paint_correction', subject: 'Swirls in the sunlight? Let’s take a look.', body: 'Paint can look glossy in the shade and show wash marks in direct sunlight. Paint correction uses machine polishing to improve those marks and restore clarity. The right approach depends on the paint and its condition. Send Pitt Stop a few photos and your year, make, and model to start an estimate.' },
  { topic: 'Interior refresh', service: 'interior', subject: 'A fresh start for your vehicle’s interior', body: 'Spills, tracked-in dirt, and everyday use can leave an interior needing more than a quick vacuum. Pitt Stop offers interior detailing tailored to the vehicle’s condition. Send a few photos of the areas you want addressed, along with your year, make, and model, and we can discuss an estimate.' },
  { topic: 'Ceramic coating expectations', service: 'ceramic', subject: 'What ceramic coating can do for your vehicle', body: 'Ceramic coating can make routine washing easier and help protect your vehicle’s finish. Preparation matters, and coating does not replace regular care. Pitt Stop can inspect your paint and explain whether correction and coating make sense for your vehicle. Contact us to discuss an estimate.' },
  { topic: 'Choosing the right detail', service: 'general', subject: 'What would you like to improve about your vehicle?', body: 'A dull exterior, a stained interior, and routine maintenance call for different approaches. At Pitt Stop, the starting point is what your vehicle needs and what matters to you. Send a few photos with your year, make, and model, and tell us what you want to improve.' },
  { topic: 'Caring for coated paint', service: 'ceramic', subject: 'A coating still needs regular care', body: 'Ceramic coating helps with maintenance, but it still needs regular washing and appropriate care. If you have questions about caring for your finish, contact Pitt Stop and tell us which coating or service your vehicle received. We can help you work out the right next step.' },
  { topic: 'Interior odor assessment', service: 'interior', subject: 'An interior odor deserves a closer look', body: 'An interior odor can have more than one cause. Addressing the source matters, and the right treatment depends on the vehicle. Pitt Stop can assess the interior and discuss detailing options. Tell us what you have noticed and send a few photos to start the conversation.' },
  { topic: 'Correction before protection', service: 'paint_correction', subject: 'Correction and protection do different jobs', body: 'Paint correction improves visible defects through polishing. Ceramic coating adds protection to the prepared finish. They serve different purposes, and not every vehicle needs the same preparation. Contact Pitt Stop to discuss the condition of your paint and your goals.' },
  { topic: 'How to request an estimate', service: 'general', subject: 'A few details help us build a useful estimate', body: 'When requesting a detailing estimate, include your vehicle’s year, make, and model, clear photos, and the areas you want addressed. That helps Pitt Stop understand the work before recommending a service. Call us or visit our website to get started.' },
]

export function localDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
function stableId(key: string): string {
  const s = createHash('sha256').update(`pitt-marketing:${key}`).digest('hex')
  return `${s.slice(0,8)}-${s.slice(8,12)}-5${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`
}
export function planSlots(startDate: string, from: Date, days = 45): PlanSlot[] {
  if (!validDate(startDate)) throw new Error('Choose a valid launch date')
  const today = localDate(from), start = today > startDate ? today : startDate
  const first = new Date(`${start}T12:00:00Z`), slots: PlanSlot[] = []
  for (let n = 0; n < Math.min(62, Math.max(1, days)); n++) {
    const d = new Date(+first + n * 86400000), date = d.toISOString().slice(0,10)
    const month = date.slice(0,7), dow = d.getUTCDay()
    const emailDate = month === startDate.slice(0,7) ? startDate : `${month}-15`
    for (const channel of ['facebook','email'] as const) {
      if (channel === 'facebook' ? ![2,5].includes(dow) : date !== emailDate) continue
      const key = channel === 'email' ? `email:${month}` : `facebook:${date}`
      const index = channel === 'email' ? (d.getUTCMonth() + 3) % TOPICS.length : Math.floor((+d - Date.UTC(2026,9,6,12)) / 86400000 / 3.5)
      const topic = TOPICS[((index % TOPICS.length) + TOPICS.length) % TOPICS.length]
      slots.push({ ...topic, key, id: stableId(key), channel, date,
        subject: channel === 'email' && month === '2026-10' ? 'Your next detail, tailored to your vehicle' : topic.subject,
        body: channel === 'email' && month === '2026-10'
          ? 'Thank you for choosing Pitt Stop. If your vehicle could use attention this fall, we can help you decide what makes sense—from an interior refresh to paint correction or ceramic coating. Reply with your year, make, and model and a few photos, or call us to discuss an estimate. We would be glad to hear from you.' : topic.body })
    }
  }
  return slots
}

/** Autonomy permits general service education only. Real-job claims/photos stay in manual review. */
export function safeAutonomousCopy(subject: string, body: string): boolean {
  const value = `${subject}\n${body}`
  return body.trim().length >= 40 && body.length <= 1800 && subject.length <= 160 &&
    validateCopy(value, { offerApproved: false }).findings.length === 0 &&
    !/(https?:\/\/|www\.|\$|\b(discount|sale|free|offer ends|openings|slots left|available this|this customer|we removed|we restored|before.?and.?after|review says|\d+\s*(year|month).*warranty)\b|\{\{|\{\$)/i.test(value)
}
export function emailHtml(body: string, campaignKey: string): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
  const url = `${SHOP_URL}/?utm_source=email&utm_medium=newsletter&utm_campaign=${encodeURIComponent(campaignKey)}`
  return `<html><body><h1>Pitt Stop Detail &amp; Auto Sales</h1>${body.split(/\n+/).filter(Boolean).map(p=>`<p>${escape(p)}</p>`).join('')}<p><a href="${url}">Discuss your next detail</a> · <a href="tel:9796966640">${SHOP_PHONE}</a></p><hr><p>Promotional email from Pitt Stop Detail &amp; Auto Sales.<br>${SHOP_ADDRESS}</p><p><a href="{$unsubscribe}">Unsubscribe from marketing emails</a></p></body></html>`
}
