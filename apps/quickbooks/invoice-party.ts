/**
 * Who a retail QB invoice is BILLED to and SENT to — the single decision for ordinary and
 * occasional third-party-billed jobs. Pure and unit-tested; the service layer wires it to the DB.
 *
 * Invariants (see migration 0049):
 *   - Ordinary job (no billing override): bill the service customer, recipient = today's behaviour.
 *     Byte-identical to the pre-feature flow.
 *   - Third-party job (billing customer set): bill THAT customer, using ITS OWN identity (name/email/
 *     phone) so QB resolves/creates the payer — NOT the recipient's email, so the payer's customer
 *     record is never stamped with one advisor's address.
 *   - recipientEmail is for Invoice.BillEmail ONLY (where the invoice is sent). It is never used as
 *     customer-identity evidence. A per-order recipient override is honoured even without a separate
 *     billing customer (e.g. two Caliber jobs, different advisors on the same company account).
 */
export interface PartyContact { name: string; email: string | null; phone: string | null }

export interface ChooseInvoicePartyInput {
  /** The service/job contact (vehicle owner / resident) — today's `jobContact`. */
  serviceContact: PartyContact
  /** The payer's directory record, when a different billing customer is set on the order. */
  billingCustomer: { displayName: string | null; email: string | null; phone: string | null } | null
  /** Per-order Invoice.BillEmail override (service advisor / company rep). */
  recipientEmailOverride: string | null
}

export interface InvoiceParty {
  /** Identity used to resolve/create the QB customer to bill. */
  contact: PartyContact
  /** Invoice.BillEmail to use, or null → caller keeps today's resolved billEmail. */
  recipientEmail: string | null
  /** True when a distinct billing customer is being billed. */
  thirdParty: boolean
}

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim()
  return t === '' ? null : t
}

export function chooseInvoiceParty(input: ChooseInvoicePartyInput): InvoiceParty {
  const recipientOverride = clean(input.recipientEmailOverride)

  if (input.billingCustomer) {
    const b = input.billingCustomer
    const name = clean(b.displayName) ?? input.serviceContact.name
    // Bill the payer using the payer's OWN identity email (not the recipient's), so resolveRetailCustomer
    // matches/creates the company and never overwrites its record with one advisor's address.
    return {
      contact: { name, email: clean(b.email), phone: clean(b.phone) },
      recipientEmail: recipientOverride ?? clean(b.email),
      thirdParty: true,
    }
  }

  // No separate payer: bill the service customer. A recipient override (if any) still steers BillEmail.
  return {
    contact: input.serviceContact,
    recipientEmail: recipientOverride, // null → caller uses the resolved customer.billEmail (unchanged)
    thirdParty: false,
  }
}
