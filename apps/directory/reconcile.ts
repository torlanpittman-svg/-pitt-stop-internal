/**
 * Historical reconciliation for Quick Entry customers that predate the directory-link fix
 * (see apps/directory/intake-customer.ts). Promotes retail Work Board jobs whose
 * `service_orders.customer_id` is NULL into the canonical directory so those customers become
 * searchable and their orders attach to a profile — WITHOUT guessing identity.
 *
 * SAFETY (matches the fix's rules, deliberately conservative):
 *   - `planReconciliation()` is READ-ONLY and always runs first — it writes nothing, ever.
 *   - A customer is LINKED to an existing directory row only on UNIQUE, non-placeholder contact
 *     evidence (email → phone). Never by name alone.
 *   - If email and phone each uniquely match but to DIFFERENT customers, or any value matches >1
 *     customer → AMBIGUOUS → left for manual review (never auto-linked).
 *   - A NEW customer is created only when identity is safe (a usable unique email or phone). A
 *     name-only order (no usable contact) is left UNRESOLVED for manual review — never auto-created.
 *   - Potential duplicates (a NEW customer whose name already exists in the directory) are flagged
 *     but not merged — a human decides.
 *   - Idempotent: applying re-uses findOrCreateIntakeCustomer (live unique-match) + ON CONFLICT DO
 *     NOTHING on the vehicle link, and already-linked orders drop out of the candidate set. Running
 *     twice cannot create a duplicate.
 *   - Writes go through getDb(), which is wrapped by the prod write-guard — so `apply` against the
 *     known production DB is BLOCKED unless explicitly acknowledged.
 */
import { getDb } from '@/platform/db'
import { eq, sql } from 'drizzle-orm'
import { customers, customerVehicles } from './schema'
import { serviceOrders } from '@/apps/workflow/schema'
import { normalizeEmail, normalizePhone } from './customer-profile'
import { usableEmail, usablePhone, findOrCreateIntakeCustomer } from './intake-customer'

const rowsOf = <T,>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[])) as T[]
const normName = (n?: string | null) => (n ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export interface LinkedItem { orderNumber: string; orderId: string; customerId: string; matchedBy: 'email' | 'phone' }
export interface CreatedItem { displayName: string; via: 'email' | 'phone'; email: string | null; phone: string | null; orderNumbers: string[]; orderIds: string[]; vehicleIds: string[]; customerId: string | null; potentialDuplicateCustomerIds: string[] }
export interface AmbiguousItem { orderNumber: string; name: string; reason: string; candidateCustomerIds: string[] }
export interface UnresolvedItem { orderNumber: string; name: string; reason: string; sameNameCustomerIds: string[] }
export interface ConflictItem { orderNumber: string; matchedCustomerId: string; note: string }

/**
 * OWNER-APPROVED one-off exceptions, keyed by EXACT order number. These override the general
 * classification for ONLY these orders — the general identity rules (no name-only merge, no
 * shared-phone identity, etc.) are completely unchanged for every other order. Each carries a note
 * for the audit trail. Added after the owner resolved the three held-for-review cases (2026-10-08).
 */
export type ApprovedException =
  | { kind: 'link-existing-by-phone'; phone: string; note: string }
  | { kind: 'create-name-only'; name: string; note: string }
  | { kind: 'business-account'; company: string; companyPhone: string | null; advisorName: string; advisorEmail: string; note: string }

export const APPROVED_EXCEPTIONS: Record<string, ApprovedException> = {
  // Bryan Brown / 2020 BMW X3 — owner confirms SAME person as the existing record (Auto Elite).
  'SO-20260807-0002': { kind: 'link-existing-by-phone', phone: '9792193199', note: 'owner-confirmed identity: same Bryan Brown (Auto Elite)' },
  // Martha Cepeda / 2020 RAV4 — owner approves a name-only canonical record (no contact invented).
  'SO-20260828-0006': { kind: 'create-name-only', name: 'Martha Cepeda', note: 'owner-approved name-only customer' },
  // Caliber Collision — business account; advisor Alicia Balanga brought this vehicle (verified on
  // the order). Bill the company; keep the advisor on THIS order only.
  'SO-20260806-0003': { kind: 'business-account', company: 'Caliber Collision', companyPhone: '9797751500', advisorName: 'Alicia Balanga', advisorEmail: 'alicia.balanga@calibercollision.com', note: 'business account; advisor preserved on this order' },
}

export interface ApprovedItem {
  orderNumber: string
  kind: ApprovedException['kind']
  note: string
  action: string            // human-readable resolution (plan) / outcome (apply)
  customerId: string | null // resolved/created billed-or-service customer, when known
  blocked?: string          // set if the approved action could not be resolved safely (plan)
}

export interface ReconcileReport {
  mode: 'dry-run' | 'apply'
  candidateOrders: number
  linked: LinkedItem[]
  created: CreatedItem[]
  ambiguous: AmbiguousItem[]
  unresolved: UnresolvedItem[]
  conflicts: ConflictItem[]
  approved: ApprovedItem[]
  summary: {
    ordersLinkedToExisting: number
    ordersIntoNewCustomers: number
    distinctNewCustomers: number
    ordersAmbiguous: number
    ordersUnresolved: number
    contactConflictsFlagged: number
    approvedExceptionsHandled: number
  }
}

interface CandidateRow {
  id: string; order_number: string; vehicle_id: string; customer_name: string | null
  q_name: string | null; q_phone: string | null; q_email: string | null
}
interface DirRow { id: string; display_name: string | null; normalized_email: string | null; normalized_phone: string | null }

function indexBy(rows: DirRow[], pick: (r: DirRow) => string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const r of rows) { const k = pick(r); if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(r.id) }
  return m
}

/**
 * READ-ONLY. Compute the full reconciliation plan without touching any row. Safe to run against
 * production (it only SELECTs). `applyReconciliation` executes the write-eligible parts.
 */
export async function planReconciliation(): Promise<ReconcileReport> {
  const db = getDb()
  const candRes = await db.execute(sql`
    SELECT so.id, so.order_number, so.vehicle_id, so.customer_name,
           q.customer_name AS q_name, q.customer_phone AS q_phone, q.customer_email AS q_email
    FROM service_orders so
    LEFT JOIN quick_entry_jobs q ON q.service_order_id = so.id
    WHERE so.source = 'quick_entry' AND so.customer_id IS NULL AND so.status <> 'cancelled'
    ORDER BY so.created_at ASC`)
  const candidates = rowsOf<CandidateRow>(candRes)

  const dirRes = await db.execute(sql`
    SELECT id, display_name, normalized_email, normalized_phone FROM customers WHERE active = true`)
  const dir = rowsOf<DirRow>(dirRes)
  const byEmail = indexBy(dir, (r) => usableEmail(r.normalized_email) || '')
  const byPhone = indexBy(dir, (r) => usablePhone(r.normalized_phone) || '')
  const byName = indexBy(dir, (r) => normName(r.display_name))
  const dirById = new Map<string, DirRow>(dir.map((r) => [r.id, r]))

  const linked: LinkedItem[] = []
  const ambiguous: AmbiguousItem[] = []
  const unresolved: UnresolvedItem[] = []
  const conflicts: ConflictItem[] = []
  const approved: ApprovedItem[] = []
  const createGroups = new Map<string, CreatedItem>()

  for (const o of candidates) {
    // Owner-approved one-off exceptions win over the general rules — but ONLY for these exact orders.
    const ex = APPROVED_EXCEPTIONS[o.order_number]
    if (ex) {
      if (ex.kind === 'link-existing-by-phone') {
        const ids = byPhone.get(usablePhone(ex.phone) || '') ?? []
        approved.push(ids.length === 1
          ? { orderNumber: o.order_number, kind: ex.kind, note: ex.note, action: `link to existing customer by phone ${ex.phone}`, customerId: ids[0] }
          : { orderNumber: o.order_number, kind: ex.kind, note: ex.note, action: `cannot resolve: phone ${ex.phone} matches ${ids.length} customers`, customerId: null, blocked: `phone matched ${ids.length}` })
      } else if (ex.kind === 'create-name-only') {
        approved.push({ orderNumber: o.order_number, kind: ex.kind, note: ex.note, action: `create name-only customer "${ex.name}" (no phone/email)`, customerId: null })
      } else {
        const existingBiz = dir.find((r) => normName(r.display_name) === normName(ex.company))
        approved.push({ orderNumber: o.order_number, kind: ex.kind, note: ex.note, customerId: existingBiz?.id ?? null,
          action: `${existingBiz ? 'reuse' : 'create'} business customer "${ex.company}", link order, keep advisor ${ex.advisorName} <${ex.advisorEmail}> on this order only` })
      }
      continue
    }

    const name = (o.q_name || o.customer_name || '').trim()
    if (!name) { unresolved.push({ orderNumber: o.order_number, name: '', reason: 'no name on order', sameNameCustomerIds: [] }); continue }

    const email = usableEmail(o.q_email)
    const phone = usablePhone(o.q_phone)
    const nemail = email ? normalizeEmail(email) : ''
    const nphone = phone ? normalizePhone(phone) : ''
    const emailMatch = nemail ? byEmail.get(nemail) ?? [] : []
    const phoneMatch = nphone ? byPhone.get(nphone) ?? [] : []

    if (emailMatch.length > 1) { ambiguous.push({ orderNumber: o.order_number, name, reason: `email matches ${emailMatch.length} customers`, candidateCustomerIds: emailMatch }); continue }
    if (phoneMatch.length > 1) { ambiguous.push({ orderNumber: o.order_number, name, reason: `phone matches ${phoneMatch.length} customers`, candidateCustomerIds: phoneMatch }); continue }

    const emailId = emailMatch.length === 1 ? emailMatch[0] : null
    const phoneId = phoneMatch.length === 1 ? phoneMatch[0] : null
    if (emailId && phoneId && emailId !== phoneId) {
      ambiguous.push({ orderNumber: o.order_number, name, reason: 'email and phone point to different customers', candidateCustomerIds: [emailId, phoneId] })
      continue
    }

    const matchedId = emailId || phoneId
    if (matchedId) {
      // HARD CONFLICT: the OTHER usable contact value on the order is present AND the matched customer
      // has a DIFFERENT non-empty value for it. This is the shared-business-line case (e.g. Caliber
      // Collision's main phone resolving to one employee while the order's email is a different
      // employee). Linking would attribute the order to the wrong person → send to manual review,
      // never auto-link. A matched customer with a BLANK counterpart is not a conflict (we'd only be
      // adding information), so that still links — with an informational note.
      const matched = dirById.get(matchedId)
      const matchedEmail = usableEmail(matched?.normalized_email)
      const matchedPhone = usablePhone(matched?.normalized_phone) ? normalizePhone(matched?.normalized_phone) : ''
      const emailConflict = phoneId && !emailId && nemail && matchedEmail && normalizeEmail(matchedEmail) !== nemail
      const phoneConflict = emailId && !phoneId && nphone && matchedPhone && matchedPhone !== nphone
      if (emailConflict || phoneConflict) {
        ambiguous.push({
          orderNumber: o.order_number, name,
          reason: emailConflict
            ? 'phone matches a customer whose email differs from the order email (likely a shared business/fleet line)'
            : 'email matches a customer whose phone differs from the order phone',
          candidateCustomerIds: [matchedId],
        })
        continue
      }
      linked.push({ orderNumber: o.order_number, orderId: o.id, customerId: matchedId, matchedBy: emailId ? 'email' : 'phone' })
      // Informational only: the matched customer simply lacks the other value (safe to link).
      if (emailId && nphone && !phoneId && !matchedPhone) conflicts.push({ orderNumber: o.order_number, matchedCustomerId: matchedId, note: 'linked by email; matched customer has no phone on file' })
      if (phoneId && nemail && !emailId && !matchedEmail) conflicts.push({ orderNumber: o.order_number, matchedCustomerId: matchedId, note: 'linked by phone; matched customer has no email on file' })
      continue
    }

    // No existing match. Create only when identity is safe (a usable unique contact value exists).
    if (!nemail && !nphone) {
      unresolved.push({ orderNumber: o.order_number, name, reason: 'name only — no usable contact to establish identity safely', sameNameCustomerIds: byName.get(normName(name)) ?? [] })
      continue
    }
    const key = nemail ? `e:${nemail}` : `p:${nphone}`
    const g = createGroups.get(key) ?? createGroups.set(key, {
      displayName: name, via: nemail ? 'email' : 'phone', email, phone, orderNumbers: [], orderIds: [], vehicleIds: [],
      customerId: null, potentialDuplicateCustomerIds: byName.get(normName(name)) ?? [],
    }).get(key)!
    g.orderNumbers.push(o.order_number); g.orderIds.push(o.id); g.vehicleIds.push(o.vehicle_id)
  }

  const created = [...createGroups.values()]
  return {
    mode: 'dry-run',
    candidateOrders: candidates.length,
    linked, created, ambiguous, unresolved, conflicts, approved,
    summary: {
      ordersLinkedToExisting: linked.length,
      ordersIntoNewCustomers: created.reduce((s, c) => s + c.orderNumbers.length, 0),
      distinctNewCustomers: created.length,
      ordersAmbiguous: ambiguous.length,
      ordersUnresolved: unresolved.length,
      contactConflictsFlagged: conflicts.length,
      approvedExceptionsHandled: approved.length,
    },
  }
}

/**
 * Execute the write-eligible parts of a plan (linked + created). Ambiguous/unresolved are never
 * touched. Idempotent (re-uses findOrCreateIntakeCustomer's live unique-match + ON CONFLICT DO
 * NOTHING). Writes go through the prod-guarded getDb(), so this is blocked against production unless
 * explicitly acknowledged. Returns the same report with mode='apply' and created[].customerId filled.
 */
export async function applyReconciliation(plan: ReconcileReport): Promise<ReconcileReport> {
  const db = getDb()

  // LINK: attach the order to the already-existing customer, and connect that customer ↔ the
  // order's vehicle (idempotent). Ambiguous/unresolved orders are intentionally never touched.
  for (const l of plan.linked) {
    await db.update(serviceOrders).set({ customerId: l.customerId }).where(eq(serviceOrders.id, l.orderId))
    const vr = await db.execute(sql`SELECT vehicle_id FROM service_orders WHERE id = ${l.orderId} LIMIT 1`)
    const vehicleId = rowsOf<{ vehicle_id: string }>(vr)[0]?.vehicle_id
    if (vehicleId) {
      await db.insert(customerVehicles).values({ customerId: l.customerId, vehicleId, source: 'quick_entry' })
        .onConflictDoNothing({ target: [customerVehicles.customerId, customerVehicles.vehicleId] })
    }
  }

  // CREATE: one new customer per group. The first order creates the row + links its vehicle;
  // subsequent orders of the SAME person resolve to that row via unique contact (no duplicate) and
  // link their own vehicle. Then stamp service_orders.customer_id so profile/history attach exactly.
  const applied = plan.created.map((c) => ({ ...c }))
  for (const c of applied) {
    let customerId: string | null = null
    for (let i = 0; i < c.orderIds.length; i++) {
      const link = await findOrCreateIntakeCustomer({ name: c.displayName, email: c.email, phone: c.phone }, c.vehicleIds[i])
      if (link) {
        customerId = link.id
        await db.update(serviceOrders).set({ customerId: link.id }).where(eq(serviceOrders.id, c.orderIds[i]))
      }
    }
    c.customerId = customerId
  }

  // APPROVED EXCEPTIONS — execute each owner-approved one-off. Narrow and auditable; nothing here
  // changes the general rules. Each links the exact order + vehicle; none merges by name alone.
  const approvedOut = plan.approved.map((a) => ({ ...a }))
  for (const a of approvedOut) {
    const ex = APPROVED_EXCEPTIONS[a.orderNumber]
    if (!ex || a.blocked) continue
    const ordRow = rowsOf<{ id: string; vehicle_id: string }>(await db.execute(
      sql`SELECT id, vehicle_id FROM service_orders WHERE order_number = ${a.orderNumber} AND customer_id IS NULL LIMIT 1`))[0]
    if (!ordRow) { a.action = 'already linked (idempotent no-op)'; continue }

    const linkVehicle = async (customerId: string) => {
      await db.update(serviceOrders).set({ customerId }).where(eq(serviceOrders.id, ordRow.id))
      await db.insert(customerVehicles).values({ customerId, vehicleId: ordRow.vehicle_id, source: 'quick_entry' })
        .onConflictDoNothing({ target: [customerVehicles.customerId, customerVehicles.vehicleId] })
    }

    if (ex.kind === 'link-existing-by-phone') {
      const nphone = normalizePhone(ex.phone)
      const ids = rowsOf<{ id: string }>(await db.execute(
        sql`SELECT id FROM customers WHERE active = true AND regexp_replace(coalesce(normalized_phone,''),'\\D','','g') = ${nphone}`))
      if (ids.length !== 1) { a.blocked = `phone matched ${ids.length}`; a.action = `skipped: ${ids.length} customers on phone ${ex.phone}`; continue }
      await linkVehicle(ids[0].id)  // reuse existing record; NO contact overwrite
      a.customerId = ids[0].id; a.action = `linked order to existing customer ${ids[0].id} (phone ${ex.phone})`
    } else if (ex.kind === 'create-name-only') {
      const [row] = await db.insert(customers).values({ displayName: ex.name, customerType: 'retail', source: 'quick_entry' })
        .returning({ id: customers.id })   // email/phone left NULL — no placeholder invented
      await linkVehicle(row.id)
      a.customerId = row.id; a.action = `created name-only customer ${row.id} ("${ex.name}")`
    } else {
      // business-account: find-or-create the company; link order + vehicle to it; record the advisor
      // on THIS order only (billing fields). Never writes the advisor's email onto the company.
      const existing = rowsOf<{ id: string }>(await db.execute(
        sql`SELECT id FROM customers WHERE active = true AND lower(trim(coalesce(display_name,''))) = ${normName(ex.company)} AND customer_type = 'business' LIMIT 1`))[0]
      let bizId = existing?.id ?? null
      if (!bizId) {
        const [row] = await db.insert(customers).values({
          displayName: ex.company, company: ex.company, customerType: 'business', source: 'manual',
          phone: ex.companyPhone, normalizedPhone: ex.companyPhone ? normalizePhone(ex.companyPhone) : null,
        }).returning({ id: customers.id })
        bizId = row.id
      }
      await linkVehicle(bizId)
      await db.update(serviceOrders).set({
        billingCustomerId: bizId, invoiceRecipientEmail: ex.advisorEmail, jobContactName: ex.advisorName,
      }).where(eq(serviceOrders.id, ordRow.id))
      a.customerId = bizId
      a.action = `${existing ? 'reused' : 'created'} business customer ${bizId}; advisor ${ex.advisorName} <${ex.advisorEmail}> kept on this order`
    }
  }

  return { ...plan, created: applied, approved: approvedOut, mode: 'apply' }
}

/** Convenience: plan (read-only) and optionally apply in one call. */
export async function reconcileQuickEntryCustomers(opts: { apply?: boolean } = {}): Promise<ReconcileReport> {
  const plan = await planReconciliation()
  return opts.apply ? applyReconciliation(plan) : plan
}
