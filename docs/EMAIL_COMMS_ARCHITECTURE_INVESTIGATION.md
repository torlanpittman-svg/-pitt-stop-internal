# Pitt Stop — Professional Email, Automated Customer Communication, QuickBooks Payment & AutoLeap-Replacement Architecture

**Plan-first investigation — 2026-09-04. No production mutations were made. No accounts, DNS, QuickBooks, or code were changed.**

---

## 0. Executive summary

- **You own two usable domains.** `pittstopdetailandautosales.com` (your live public WordPress site on GoDaddy, since 2019) and `pittstopdetail.com` (short, newer, **DNS already delegated to Vercel**). Neither has any email configured today.
- **Recommendation: run all email on `pittstopdetail.com`.** Its DNS lives on Vercel where you already operate, so you can add email records **without ever touching the GoDaddy WordPress site**, addresses are short/professional, and it cleanly matches the OS brand.
- **Humans → Google Workspace. App → Resend.** Both authorized on the same domain with non-conflicting DNS. Three paid mailboxes (torlan/darryl/tony); role addresses (service/billing/invoices/support) as **free aliases/groups**.
- **QuickBooks CAN give you a supported customer-facing view+pay link** (`InvoiceLink`), and your code already **creates invoices without sending QB's email** — so the "one branded Vehicle-Ready email" design is fully achievable with no duplicate sends.
- **AutoLeap cancellation verdict: CLOSE — a few specific items first** (see §19). The retail money pipeline is essentially built; the gaps are payment-status writeback, a customer-history screen, and (minor) scheduling.

---

## 1. Current domain

| Fact | `pittstopdetailandautosales.com` | `pittstopdetail.com` |
|---|---|---|
| Role | **Live public marketing website** | Short domain, currently a small Vercel page ("Pitt Stop") |
| Registered | 2019-01-11 (6+ yrs) | 2025-06-24 |
| Expires | 2028-01-11 | 2027-06-24 |
| Registrar | Wild West Domains, LLC (GoDaddy's reseller brand) | GoDaddy.com, LLC |
| Nameservers / DNS | `ns41/ns42.domaincontrol.com` → **GoDaddy DNS** | `ns1/ns2.vercel-dns.com` → **Vercel DNS** |
| Hosting | A `69.16.238.95` → WordPress/Apache/PHP on GoDaddy | A → Vercel |
| Site title | "Home – Automotive Experts of Texas \| Pitt Stop Detail and Auto Sales" | "Pitt Stop" |
| Email records (MX/SPF/DKIM/DMARC) | **None** | **None** |

- `pittstop.com` is **not yours** (Shopify store on Namecheap/privateemail — a different business). Do not pursue it.
- Pitt Stop OS itself is a **separate** Vercel project `pitt-stop-internal` (org `team_TGngJQMpvAgMrRXyILLlPNk6`) served at `pitt-stop-internal.vercel.app`. It is unrelated to the public marketing website's hosting.

**What proves / doesn't prove control:**
- *Proven from within tooling:* `pittstopdetail.com` nameservers point at Vercel; if it appears under your Vercel dashboard's Domains, that is proof you control its DNS. (Verify in Vercel — see Owner Actions.)
- *Likely:* both domains are registered at GoDaddy under your account (RDAP shows GoDaddy/Wild West Domains).
- *Unknown until you log in:* the GoDaddy account credentials and the WordPress admin for the marketing site. Public DNS shows configuration, not ownership.

---

## 2. Do we actually control the domains?

- **`pittstopdetail.com` — LIKELY fully controlled by you.** DNS is on Vercel (your platform). Confirm by opening Vercel → your account → Domains and checking it is listed. If it is, you can add email DNS records yourself in minutes with zero risk to the marketing site.
- **`pittstopdetailandautosales.com` — control UNKNOWN until you log into GoDaddy.** The website clearly is yours (branding), but adding email here means editing GoDaddy DNS, which is riskier and unnecessary given the recommendation below.

There are **no domain credentials in the repo or environment** (correctly — none should be). Registrar/website logins are Owner Actions.

---

## 3. Website / DNS relationship (what can change, what must not)

Think of DNS records by job:

| Record | Job | Touches the website? |
|---|---|---|
| **A / CNAME** | Where the website lives | **Yes — do not touch.** These serve your site. |
| **MX** | Where email is *received* | No — email only. Adding MX where none exists cannot break a website. |
| **SPF (TXT)** | Which servers may *send* as the domain | No — email only. **Only one SPF TXT record may exist** — must be merged, never duplicated. |
| **DKIM (TXT)** | Cryptographic signature per sender | No — email only. Each sender uses its own selector (`google._domainkey`, `resend._domainkey`) — they coexist. |
| **DMARC (TXT at `_dmarc`)** | Policy + reporting | No — email only. |

**Because we recommend `pittstopdetail.com` (DNS on Vercel):**
- **Safe to add:** MX (Google), SPF, DKIM (Google + Resend), DMARC, and Resend's verification records.
- **Must remain untouched:** the existing Vercel A/CNAME records for the `pittstopdetail.com` page.
- **The GoDaddy WordPress site (`pittstopdetailandautosales.com`) is never touched at all** under this plan — its A records and hosting are completely isolated. This is the core safety benefit of choosing the Vercel-managed domain for email.

---

## 4. Recommended human email

**Provider: Google Workspace Business Starter** (you already like Gmail; this *is* Gmail with your domain, full mobile/app compatibility, admin console, security).

**Mailbox structure on `pittstopdetail.com`:**

| Address | Type | Cost |
|---|---|---|
| `torlan@pittstopdetail.com` | **Paid mailbox** (real inbox) | 1 seat |
| `darryl@pittstopdetail.com` | **Paid mailbox** | 1 seat |
| `tony@pittstopdetail.com` | **Paid mailbox** | 1 seat |
| `service@pittstopdetail.com` | **Google Group** (shared, monitored by all three) | free |
| `billing@pittstopdetail.com` | **Google Group** or alias | free |
| `invoices@pittstopdetail.com` | **Alias** → routes to billing/service | free |
| `support@pittstopdetail.com` | **Group/alias** → service | free |

- **Only 3 paid seats are needed.** Each user supports up to ~30 aliases free; Google Groups are free and need no seat. Role addresses do **not** each require a paid mailbox.
- Use a **Group** (not a plain alias) for `service@` so multiple people see and can reply to customer replies, with history retained — ideal for the Vehicle-Ready reply flow.
- **Cost: ~$21/mo** (3 × ~$7/user/mo annual) — role addresses add $0. (List price $7; Google was showing a 50%-off-first-year promo as of 2026-09-04.)

*Alternative considered:* Microsoft 365 Business Basic (~$6/user/mo). Genuinely comparable, but you already prefer Gmail and the OS ecosystem is Google-adjacent — **stay with Google Workspace.** No compelling reason to split.

---

## 5. Recommended automated (transactional) Pitt Stop OS email

**Provider: Resend.** Clean API, first-class domain auth, generous free tier, easy React/HTML templates. The repo has **no email infrastructure today**, so this is a greenfield add.

- **From:** `Pitt Stop Detail & Auto Sales <service@pittstopdetail.com>`
- **Reply-To:** `service@pittstopdetail.com` (the monitored Google Group — customer replies reach a human).
- **Authentication:** verify `pittstopdetail.com` in Resend → add Resend's DKIM selector + a `send.`/MAIL FROM subdomain record + SPF include. This is **separate** from Google's DKIM selector, so both send legitimately.
- **Volume/cost:** Pitt Stop's retail throughput is on the order of tens of emails/day. **Resend free tier = 3,000 emails/month (100/day)** — comfortably free at current volume. Pro is $20/mo (50k) only if you later add heavy volume.

**Why a provider instead of "log into Gmail":** the app must never store a human's Gmail password; a transactional provider gives per-message API keys, delivery/bounce tracking, retries, idempotency, and audit — none of which a shared Gmail login provides. Google Workspace = humans; Resend = the app. Both on one domain, cleanly separated.

---

## 6. Domain authentication / deliverability

Yes — **Google Workspace and Resend can both be authorized on `pittstopdetail.com` simultaneously.** The only conflict risk is SPF, which you avoid by keeping a **single** SPF TXT record that includes both:

```
v=spf1 include:_spf.google.com include:amazonses.com ~all
```
*(Resend sends over Amazon SES infrastructure; use the exact include Resend's dashboard shows at setup.)*

- **DKIM:** Google publishes `google._domainkey`; Resend publishes `resend._domainkey` (or a `send` subdomain selector). Different selectors → no collision.
- **DMARC:** start at `p=none` with reporting (`rua=`) to observe, then tighten to `quarantine` once both senders show aligned pass. One `_dmarc` TXT record covers the whole domain.
- **MX:** Google's MX records handle *inbound*. Resend needs no MX (it only sends); its optional MAIL FROM subdomain gets its own records.

**Do not create two SPF records.** Merge includes into one. (No DNS changes during this task.)

---

## 7. From / Reply-To strategy

**Recommended permanent identity:**
- **From:** `Pitt Stop Detail & Auto Sales <service@pittstopdetail.com>`
- **Reply-To:** `service@pittstopdetail.com`

Recommendation among the options:
- **`service@` ✅** — best. Human, friendly, monitored, matches "your vehicle is ready."
- `invoices@` / `billing@` — fine for the *billing* thread, but "service" reads better on a Vehicle-Ready message. Use `billing@` as the Reply-To only if you want payment questions siloed.
- `notifications@` — acceptable but colder.
- `noreply@` ❌ — avoid. You explicitly want customers to be able to reply, and monitored-reply improves deliverability and trust.

**`service@` should be a Google Group** (shared, no paid seat, all three owners see replies, history retained). That is the cleanest workflow and costs nothing.

---

## 8. QuickBooks payment experience — what's actually supported

**DOCUMENTED / SUPPORTED:**
- QuickBooks Online API exposes an **`InvoiceLink`** field: `GET .../invoice/{id}?include=invoiceLink&minorversion=<≥36>` returns a **public URL where the customer can view and pay the invoice online.** This is the supported way to obtain a hosted view+pay link. The **"Pay" capability requires QuickBooks Payments to be connected** to your QBO company (you already process retail payments, so this is likely already on — verify).
- The link is **temporary / regenerated on read** — fetch it fresh at send time and embed it in the email; **do not store it long-term.**
- Your code already **creates invoices without emailing** (`createRetailInvoiceInQB`), and separately can email via QB (`sendRetailInvoiceInQB`). So the pieces exist.

**OBSERVED BUT NOT USED:** the repo does **not** currently request `InvoiceLink` anywhere (`grep` found no `invoiceLink`/`AllowOnline` usage). Today the only customer email path is QuickBooks' own generic send.

**NOT AVAILABLE / OUT OF SCOPE:** building our own payment processing or inventing an undocumented pay URL. **QuickBooks stays responsible for payment processing** — correct and required.

**Recommended approach:** after creating the retail invoice, call the invoice GET with `include=invoiceLink`, put that URL behind the **[View & Pay Invoice]** button in our branded email. No token is ever exposed to the customer beyond QB's own hosted link.

---

## 9. Avoiding double emails

Your code makes this clean:
- `createRetailInvoiceInQB` **creates only — no email is sent** (confirmed in `apps/quickbooks/retail-invoice-write.ts`).
- QB's generic email fires **only** if we call `sendRetailInvoiceInQB` (`POST /invoice/{id}/send`).

**Future retail flow (design):** create the QB invoice silently → fetch `InvoiceLink` → send **our** single branded "Vehicle Ready + View & Pay" email via Resend → **never call the QB send for retail.** Result: exactly one intentional customer message.

**Dealer stays exactly as-is** — dealer QB state lives on `dealer_scans.qb_*`, fully isolated from retail, and dealer communications are untouched.

---

## 10. Retail Vehicle-Ready workflow (future design — not implemented)

```
Retail Job completed (canonical RETAIL source)
  → manager finalizes pricing (authoritative Invoice Draft)
  → OS creates QB invoice  (createRetailQBInvoice — idempotent, PSID-tagged, no send)
  → verify Job ↔ customer ↔ invoice linkage + total invariant (already enforced)
  → OS fetches InvoiceLink (view+pay URL)
  → OS sends ONE branded email via Resend:
       From: Pitt Stop Detail & Auto Sales <service@pittstopdetail.com>
       Reply-To: service@pittstopdetail.com
       Subject: Your Vehicle Is Ready for Pickup – Pitt Stop
       Body: greeting + canonical vehicle + [View & Pay Invoice] → InvoiceLink
  → customer views/pays via QuickBooks (Payments)
  → payment status flows back (see §15 — the gap to close)
  → Job + customer history retains invoice # and the communication record
```

**Fail-closed rules** (reuse existing logic): if canonical customer identity or email is ambiguous/conflicting/missing, **do not send** — surface for manager review (mirrors `decideSendRecipient` and the wrong-customer fail-closed fix). Email uses only canonical customer/vehicle/invoice/amount/link — no AI-generated fields.

---

## 11. Dealer separation

- Send the Vehicle-Ready email **only** for Jobs whose **canonical source classification is RETAIL** — reuse `isDealerOrder` / `orderSourceKind`; never invent a new classifier.
- **Never** send to Sterling, Kia, Subaru, other dealers, or unknown-source Jobs.
- Dealer invoicing/communication paths remain byte-for-byte unchanged (separate `dealer_scans.qb_*` state, separate Dealer Check-In flow).

---

## 12. Future SMS (design-ready, not built)

Model the notification as a **channel-agnostic communication event** so email today and SMS later share one pipeline:

```
communication:
  type: invoice_ready        # (Vehicle Ready + pay link)
  job_id / customer_id / invoice_id
  channels: [email]          # later: [email, sms]
  payload: { customerName, vehicle, invoiceNumber, amount, payLink }
  status per channel: queued | sent | delivered | failed
  idempotency_key            # one intentional send per (job, type)
```

- Email adapter = Resend now. SMS adapter = **Twilio** later (or Resend's SMS if offered) — same event, new adapter. No rebuild.
- SMS body: *"Your vehicle is ready for pickup. View/pay: {payLink}"* using the same canonical fields + the same QB `InvoiceLink`.
- Keep it this simple — a `communications` table + an adapter interface. Don't over-engineer a full messaging bus today.

---

## 13. Customer / vehicle history

**Exists (data):** canonical `vehicles`, `service_orders` (+ `service_order_events` append-only audit, `service_order_assignments`), `job_estimates` / `job_services` / `job_line_items` (pricing + QB linkage), and a `customers` / `customer_vehicles` directory imported from AutoLeap/QuickBooks/Quick Entry.

**Missing (surfacing):** there is **no browsable "open a customer" screen.** History is keyed by *vehicle/Job*, and the customer directory tables exist mainly for intake matching — there is no UI that answers, in one place:

- What vehicles have we serviced for this customer?
- What did we do to each, when, and what did we charge?
- Which invoice was created, and **was it paid?**
- What communications were sent?

The raw data to build most of this is present; the **customer-centric read model + UI is the gap** (and "was it paid" depends on §15).

---

## 14. (folded into §13)

---

## 15. Payment / accounting reconciliation

**What Pitt Stop OS knows today, per retail Job (`job_estimates`):** invoice created (`qb_invoice_id`/number), invoice **sent** (`qb_status='sent'`, QB `EmailStatus`), sync token, and the authoritative total. A live read of the QB invoice (`/api/quickbooks/query-invoice`) can return `Balance` on demand.

**What the CFO/finance layer knows (aggregate):** the daily cron (`syncFromQbo`) pulls **P&L, Balance Sheet, and Aged Receivables** — so accounting-level A/R and cash are refreshed daily.

**The gap:** there is **no per-invoice PAID-status writeback to the Job.** `qb_status` stops at `sent`; nothing marks a specific invoice **paid**, records **payment method/amount/partial/outstanding balance**, or closes the Job financially. There is **no QuickBooks webhook** and no per-invoice balance poll. So "did *this* customer pay *this* invoice?" requires a manual live query, not an automatic status.

**To close it (design, not built):** either (a) a lightweight poll — for Jobs with `qb_status IN (sent)` and an open invoice, re-read `Balance`/`LinkedTxn` on the existing daily cron and set `qb_status='paid'` + store amount/date; or (b) subscribe to QBO **Invoice/Payment webhooks** for near-real-time. Option (a) reuses existing infrastructure and is the smaller first step.

---

## 16. Cost

| Item | Plan / basis | Monthly | Annual |
|---|---|---|---|
| **Domain — email** | `pittstopdetail.com` already owned (renews ~$20/yr, GoDaddy) | — | ~$20 |
| **Domain — website** | `pittstopdetailandautosales.com` already owned (renews to 2028) | — | (already paid) |
| **Google Workspace** | Business Starter × **3 seats** (~$7/user/mo list; role addrs free) | **~$21** | **~$252** |
| **Resend** | Free tier (3k/mo) covers current volume | **$0** | **$0** |
| **QuickBooks Payments** | Already in use; per-transaction fees only (no new subscription) | $0 new | $0 new |
| **SMS (later, optional)** | Twilio: ~$1.15 number + ~$4 brand + ~$10 campaign + ~$0.011/msg | ~$15–27 | ~$180–320 |

- **Incremental monthly (email go-live): ~$21/mo** (Google Workspace only; Resend free).
- **Incremental annual: ~$252/yr** + ~$20 domain renewal.
- **One-time:** $0 (domains owned; no purchases required).
- SMS is deferred and additive when you choose to enable it.

---

## 17. Owner actions required (grouped)

For each: *what / why / exactly do / where / bring back / unlocks.*

1. **Confirm Vercel controls `pittstopdetail.com`**
   - *Why:* determines whether email DNS is a 5-minute self-serve add with zero website risk.
   - *Do:* Vercel dashboard → your account → **Domains**; confirm `pittstopdetail.com` is listed and points to Vercel DNS.
   - *Bring back:* yes/no + a screenshot of its DNS records.
   - *Unlocks:* the entire "email on the Vercel-managed domain" plan (steps that need DNS).

2. **Decide the email domain** *(recommendation: `pittstopdetail.com`)*
   - *Why:* branding call — your public website is on the longer domain, but email is cleaner/safer on the short one. Many businesses split website vs. email domains; it's fine.
   - *Do:* choose `pittstopdetail.com` (recommended) OR `pittstopdetailandautosales.com`. If the latter, you'll instead edit GoDaddy DNS (riskier).
   - *Bring back:* the chosen domain.
   - *Unlocks:* Workspace + Resend setup.

3. **GoDaddy account access** *(only needed if you pick the long domain, or want a website→short-domain redirect)*
   - *Why:* to edit DNS on the GoDaddy-managed domain.
   - *Do:* confirm you can log into GoDaddy for these domains.
   - *Bring back:* confirmation you have access (not the password).

4. **Create Google Workspace** (paid account creation)
   - *Why:* provisions professional mailboxes; only you can create the paid account and be super-admin.
   - *Do:* workspace.google.com → start Business Starter → domain = chosen domain → verify → create `torlan@`, `darryl@`, `tony@`, then Groups/aliases for `service@`, `billing@`, `invoices@`, `support@`.
   - *Bring back:* confirmation + who should own `service@` group.
   - *Unlocks:* human email; monitored Reply-To.

5. **Confirm QuickBooks Payments is connected** to the QBO company
   - *Why:* the invoice **Pay** button (and `InvoiceLink` pay capability) requires it.
   - *Do:* QBO → check Payments is active for online invoice payment.
   - *Bring back:* confirmed on/off.
   - *Unlocks:* customer online pay in the branded email.

6. **Create a Resend account + generate an API key** (external account; free)
   - *Why:* the app's sending provider; the key is a production secret.
   - *Do:* resend.com → sign up → add domain (chosen) → it will show DNS records to add.
   - *Bring back:* the API key (to store as a Vercel secret) + the DNS records it lists.
   - *Unlocks:* app-sent transactional email.

7. **DNS changes (MX / SPF / DKIM / DMARC / Resend verification)** — *approve before I apply, or apply yourself*
   - *Why:* enables receiving (Google) and authenticated sending (Google + Resend).
   - *Do:* on the chosen domain's DNS, add Google MX + one merged SPF + Google DKIM + Resend DKIM/verification + one DMARC. **Do not** touch existing A/CNAME.
   - *Bring back:* confirmation records are live (I can then verify propagation read-only).

*(Everything else below is CLAUDE work once these unlock.)*

---

## 18. Claude actions (what I can implement afterward)

- Add a small **email/communications module** (Resend adapter, templates, `communications` table, idempotency + audit + retry) — channel-agnostic for future SMS.
- Wire **retail create-without-send + fetch `InvoiceLink`** into a branded **Vehicle-Ready** send, gated to **canonical RETAIL** Jobs, fail-closed on ambiguous identity/email.
- Add a **paid-status reconciliation** step (poll `Balance` on the existing daily cron → set `qb_status='paid'` + amount/date), then optionally QBO webhooks.
- Build a **customer-history read model + screen** (vehicles → jobs → services → invoices → paid? → communications).
- Internal test harness (send to our own inboxes) before any customer send.
- Replace the `torlanpittman@gmail.com` contact on privacy/terms pages with a role address.

---

## 19. Implementation order (dependency-ordered; OWNER vs CLAUDE; type)

| # | Step | Who | Type |
|---|---|---|---|
| 1 | Confirm Vercel controls `pittstopdetail.com` | OWNER | READ-ONLY |
| 2 | Decide email domain (rec: pittstopdetail.com) | OWNER | DECISION |
| 3 | Confirm registrar/DNS access (GoDaddy if needed) | OWNER | READ-ONLY |
| 4 | Create Google Workspace + verify domain | OWNER | EXTERNAL ACCOUNT |
| 5 | Create `torlan/darryl/tony` mailboxes | OWNER | CONFIGURATION |
| 6 | Create `service/billing/invoices/support` groups/aliases | OWNER | CONFIGURATION |
| 7 | Add Google MX + merged SPF + Google DKIM + DMARC | OWNER (or CLAUDE-guided) | DNS |
| 8 | Create Resend account + verify domain (DKIM/SPF include) | OWNER | EXTERNAL ACCOUNT + DNS |
| 9 | Confirm QuickBooks Payments connected | OWNER | READ-ONLY |
| 10 | Store `RESEND_API_KEY` + `EMAIL_FROM`/`REPLY_TO` as Vercel secrets | OWNER (or CLAUDE-prepared) | PRODUCTION SECRET |
| 11 | Build communications module (adapter/templates/table/idempotency) | CLAUDE | CODE |
| 12 | Wire QB `InvoiceLink` fetch into retail flow | CLAUDE | CODE |
| 13 | Implement Vehicle-Ready send (RETAIL-gated, fail-closed) | CLAUDE | CODE |
| 14 | Internal-only test send (our inboxes) | CLAUDE | CODE (safe test) |
| 15 | Controlled single real retail test (one consenting customer) | OWNER + CLAUDE | PRODUCTION CHANGE |
| 16 | Enable retail automation | OWNER toggle | PRODUCTION CHANGE |
| 17 | Add paid-status reconciliation (poll → `paid`) | CLAUDE | CODE |
| 18 | Build customer-history screen | CLAUDE | CODE |
| 19 | Re-evaluate remaining AutoLeap blockers → cancel when safe | OWNER | DECISION |

---

## 20. Risks & mitigations

- **Website downtime:** none if we use `pittstopdetail.com` — its A/CNAME are untouched, and the GoDaddy WordPress site is never edited. Never modify A/CNAME.
- **DNS/SPF conflict:** the #1 real risk — **only one SPF record**; merge Google + Resend includes. DKIM uses distinct selectors (safe).
- **Deliverability/spam:** mitigated by proper SPF+DKIM+DMARC, a real monitored Reply-To (not noreply), and warming naturally at low volume.
- **QuickBooks integrity:** retail create-without-send is already the code's behavior; dealer path isolated; total-invariant enforced pre/post write; wrong-customer already fail-closed.
- **Duplicate customer emails:** guaranteed single send by (a) not calling QB's send for retail and (b) an idempotency key per (Job, `invoice_ready`).
- **Secrets:** no Gmail password stored anywhere; Resend key lives as a Vercel secret; QB tokens remain encrypted and never decrypted locally.
- **Reversibility:** email is behind a feature flag; a bad send path can be disabled instantly without affecting invoicing or the website.

---

## 21. Final recommended architecture

```
DOMAIN (email + app):   pittstopdetail.com        (DNS on Vercel — website untouched)
DOMAIN (marketing web): pittstopdetailandautosales.com  (unchanged, GoDaddy/WordPress)

HUMAN EMAIL:            Google Workspace Business Starter (3 seats)
  MAILBOXES:           torlan@ · darryl@ · tony@
  GROUPS/ALIASES:      service@ (Group) · billing@ · invoices@ · support@   (free)

AUTOMATED EMAIL:       Resend (free tier)
  FROM:                Pitt Stop Detail & Auto Sales <service@pittstopdetail.com>
  REPLY-TO:            service@pittstopdetail.com   (monitored Group)
  AUTH:                one merged SPF · Google DKIM + Resend DKIM · DMARC p=none→quarantine

PAYMENT:               QuickBooks (Payments) hosted invoice via InvoiceLink (supported)
APPLICATION:           Pitt Stop OS — create-without-send → InvoiceLink → one branded email
COMMS MODEL:           channel-agnostic communications(type=invoice_ready, channel=email|sms)
FUTURE SMS:            Twilio adapter, same event — architecture-ready
```

---

## 22. AutoLeap cancellation verdict

### CLOSE — COMPLETE THESE SPECIFIC ITEMS FIRST

The retail money pipeline you actually use — intake → VIN → Job → services/pricing → Work Board → Production → manager invoice → **QuickBooks invoice** — is **built and live**, and dealer is fully separated. What still stands between you and cancelling AutoLeap:

**BLOCKERS TO CANCELLATION**
1. **Customer-facing Vehicle-Ready communication** (this project) — not yet built. AutoLeap is still how customers are notified/paid smoothly. *Design is ready; needs email infra + the send.*
2. **Payment-status writeback per invoice** (§15) — the OS can't yet tell you "invoice #X was paid" automatically. Needed before you rely on it instead of AutoLeap for closing jobs.
3. **Customer-history screen** (§13) — you can't yet open a customer and see vehicles/jobs/invoices/paid/comms in one place. This is a core thing AutoLeap gives you day-to-day.

**IMPORTANT BUT NOT BLOCKING**
- Directory is still AutoLeap-sourced with **no API mapping** (`autoleap_map_status = unmapped_pending_api`) — fine to run off the imported snapshot short-term, but plan the durable source of truth.
- Partial-payment / outstanding-balance surfacing (depends on #2).

**NICE TO HAVE**
- Appointment/scheduling (AutoLeap has it; the OS has no booking/calendar). Only matters if you actually schedule via AutoLeap today.
- SMS notifications (§12).
- Richer per-vehicle service catalog/labor-guide parity.

**Bottom line:** you are close, not ready. Finish (1) the branded Vehicle-Ready email, (2) automatic paid-status, and (3) the customer-history screen, run a controlled parallel period, then do a controlled cutover. Do **not** cancel AutoLeap until those three are in production and verified.

---

*End of investigation report. No changes were made to DNS, domains, QuickBooks, accounting, production code, secrets, or customer communications. Nothing was deployed or sent.*
