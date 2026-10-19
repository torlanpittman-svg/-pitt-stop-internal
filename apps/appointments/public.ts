/**
 * What a customer may see about THEIR appointment — an allowlist. Internal notes, linked customer /
 * order / lead ids, attribution, capacity and staff fields never leave the server.
 */
import type { Appointment } from './db'
import { type BookingConfig, formatDateLabel, formatTimeLabel, toMinutes, fromMinutes } from './policy'

export interface PublicAppointment {
  reference: string
  status: 'confirmed' | 'arrived' | 'cancelled' | 'no_show'
  date: string
  time: string
  dateLabel: string
  timeLabel: string
  services: string
  vehicle: string
  firstName: string
  phone: string
  email: string | null
  startsAt: string
}

export function publicSummary(a: Appointment): PublicAppointment {
  return {
    reference: a.reference,
    status: a.status as PublicAppointment['status'],
    date: a.localDate, time: a.localTime,
    dateLabel: formatDateLabel(a.localDate), timeLabel: formatTimeLabel(a.localTime),
    services: a.serviceLabels,
    vehicle: [a.vehicleYear, a.vehicleMake, a.vehicleModel].filter(Boolean).join(' '),
    firstName: a.firstName, phone: a.phone, email: a.email,
    startsAt: a.startsAt.toISOString(),
  }
}

/** Can the customer still cancel online? (outside render so components stay pure) */
export function canCustomerCancel(a: Pick<Appointment, 'status' | 'startsAt'>, cfg: Pick<BookingConfig, 'cancelCutoffMinutes'>, now = new Date()): boolean {
  return a.status === 'confirmed' && a.startsAt.getTime() - cfg.cancelCutoffMinutes * 60_000 > now.getTime()
}
export const isFuture = (d: Date, now = new Date()) => d.getTime() > now.getTime()

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const icsUtc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** A 30-minute "drop-off" calendar entry (the drop-off window, not a finish time). */
export function appointmentIcs(a: Appointment, cfg: BookingConfig): string {
  const end = new Date(a.startsAt.getTime() + 30 * 60_000)
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pitt Stop Detail & Auto Sales//Appointments//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${a.reference}@pittstopdetailandautosales.com`,
    `DTSTAMP:${icsUtc(new Date())}`,
    `DTSTART:${icsUtc(a.startsAt)}`,
    `DTEND:${icsUtc(end)}`,
    `SUMMARY:${icsText(`Pitt Stop drop-off — ${a.serviceLabels}`)}`,
    `LOCATION:${icsText(cfg.address)}`,
    `DESCRIPTION:${icsText(`Reference ${a.reference}. ${cfg.instructions} Questions: ${cfg.phone}`)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n')
}

/** Every selectable time for a day (staff pickers), independent of public rules. */
export function allTimes(start = '07:00', end = '18:00', step = 15): string[] {
  const out: string[] = []
  for (let m = toMinutes(start); m <= toMinutes(end); m += step) out.push(fromMinutes(m))
  return out
}
