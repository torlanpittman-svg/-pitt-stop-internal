"""
Phase 1: Create replacement QBO invoice for lost Sterling Subaru invoice (was 100803).
Phase 2: Paginate all 9 pages of the QBO Audit Log and identify every dealership
         invoice that AutoLeap overwrote, replaced, or otherwise corrupted.

Dealer accounts to track: Sterling Subaru, Sterling Kia, Sterling Auto Group,
Sterling Auto, and any other dealer patterns.
"""
import os, json, re, time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "full_recovery_report.json")

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

DEALER_PATTERNS = ["Sterling", "dealer", "Dealer", "Auto Group", "Subaru", "Kia",
                   "BMW", "Toyota", "Honda", "Ford", "Chevrolet", "Chevy", "Mazda",
                   "Hyundai", "Nissan", "VW", "Volkswagen"]

def log(msg): print(msg, flush=True)

def ss(page, name):
    try: page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)
    except: pass

def wait_for_ready():
    if os.path.exists(READY_F):
        os.remove(READY_F); log("READY."); return
    log(f"Waiting for READY:  touch {READY_F}")
    while not os.path.exists(READY_F): time.sleep(3)
    os.remove(READY_F); log("READY.")

def safe_text(page):
    try: return page.inner_text("body")
    except: return ""


# ── PHASE 1: Create replacement invoice ───────────────────────────────────────

REPLACEMENT_INVOICE = {
    "customer": "Sterling Subaru",
    "email": "billing@sterlingautogroup.net",
    "date": "07/22/2026",
    "due_date": "07/22/2026",
    "taxable": False,
    "lines": [
        {"product": "Complete Detail", "description": "2024 Subaru Crosstrek Silver #U761088",
         "qty": "1", "rate": "200", "account": "Detail Sales"},
        {"product": "Complete Detail", "description": "2023 Hyundai Tucson Red #U253409",
         "qty": "1", "rate": "200", "account": "Detail Sales"},
    ],
    "total": 400.00,
    "note": "Replacement for lost invoice 100803 (overwritten by AutoLeap Jul 24 2026)",
}

def create_replacement_invoice(page):
    log("\n" + "="*60)
    log("PHASE 1: Creating replacement invoice for lost 100803")
    log("="*60)

    # Navigate to Create Invoice
    page.goto("https://qbo.intuit.com/app/invoice?action=create",
              wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(5000)
    ss(page, "create_01_blank")
    log(f"  Create invoice URL: {page.url}")

    # ── Customer ──────────────────────────────────────────────────────────────
    log("\n  Setting customer: Sterling Subaru")
    try:
        cust_input = page.locator(
            "input[placeholder*='Customer'], input[aria-label*='Customer' i], "
            "[data-testid*='customer'] input, #customerName input, "
            ".customer-name input, input[name*='customer']"
        ).first
        cust_input.fill("Sterling Subaru")
        page.wait_for_timeout(2000)
        # Select from dropdown
        dropdown = page.locator("[role='option']:has-text('Sterling Subaru'), "
                                "li:has-text('Sterling Subaru'), "
                                "[class*='option']:has-text('Sterling Subaru')").first
        if dropdown.count() > 0:
            dropdown.click()
            log("  Customer selected from dropdown")
        else:
            page.keyboard.press("Enter")
            log("  Customer entered via keyboard")
        page.wait_for_timeout(2000)
        ss(page, "create_02_customer")
    except Exception as e:
        log(f"  Customer input error: {e}")

    # ── Invoice Date ──────────────────────────────────────────────────────────
    log("\n  Setting invoice date: 07/22/2026")
    try:
        date_inputs = page.locator(
            "input[aria-label*='Invoice date' i], input[placeholder*='Invoice date' i], "
            "input[aria-label*='Date' i]:not([aria-label*='Due' i]):not([aria-label*='Ship' i])"
        )
        log(f"  Date inputs found: {date_inputs.count()}")
        if date_inputs.count() > 0:
            d = date_inputs.first
            d.triple_click()
            d.fill("07/22/2026")
            page.keyboard.press("Tab")
            page.wait_for_timeout(1000)
    except Exception as e:
        log(f"  Date input error: {e}")

    # ── Due Date ──────────────────────────────────────────────────────────────
    log("\n  Setting due date: 07/22/2026")
    try:
        due = page.locator(
            "input[aria-label*='Due date' i], input[placeholder*='Due date' i]"
        ).first
        if due.count() > 0:
            due.triple_click()
            due.fill("07/22/2026")
            page.keyboard.press("Tab")
            page.wait_for_timeout(1000)
    except Exception as e:
        log(f"  Due date error: {e}")

    ss(page, "create_03_dates")

    # ── Line Items ────────────────────────────────────────────────────────────
    for idx, line in enumerate(REPLACEMENT_INVOICE["lines"]):
        log(f"\n  Adding line {idx+1}: {line['description']}")
        row_num = idx + 1

        # Find the line item row — try different selectors
        try:
            # Product/Service column
            prod_cell = page.locator(
                f"[data-testid='line-item-{row_num}-product'], "
                f"tbody tr:nth-child({row_num}) [aria-label*='Product' i], "
                f"tbody tr:nth-child({row_num}) [placeholder*='Product' i], "
                f"tbody tr:nth-child({row_num}) input[class*='product' i]"
            ).first

            if prod_cell.count() > 0:
                prod_cell.fill(line["product"])
                page.wait_for_timeout(1500)
                opt = page.locator(f"[role='option']:has-text('{line['product']}'), "
                                   f"li:has-text('{line['product']}')").first
                if opt.count() > 0:
                    opt.click()
                    page.wait_for_timeout(1000)
                else:
                    page.keyboard.press("Escape")
            else:
                log(f"  Product cell not found for row {row_num}")

            # Description
            desc_cell = page.locator(
                f"tbody tr:nth-child({row_num}) [aria-label*='Description' i], "
                f"tbody tr:nth-child({row_num}) [placeholder*='Description' i], "
                f"tbody tr:nth-child({row_num}) textarea"
            ).first
            if desc_cell.count() > 0:
                desc_cell.fill(line["description"])
                page.wait_for_timeout(500)

            # Qty
            qty_cell = page.locator(
                f"tbody tr:nth-child({row_num}) [aria-label*='Qty' i], "
                f"tbody tr:nth-child({row_num}) [aria-label*='Quantity' i], "
                f"tbody tr:nth-child({row_num}) input[class*='qty' i]"
            ).first
            if qty_cell.count() > 0:
                qty_cell.triple_click()
                qty_cell.fill(line["qty"])
                page.wait_for_timeout(500)

            # Rate
            rate_cell = page.locator(
                f"tbody tr:nth-child({row_num}) [aria-label*='Rate' i], "
                f"tbody tr:nth-child({row_num}) [aria-label*='Price' i], "
                f"tbody tr:nth-child({row_num}) input[class*='rate' i]"
            ).first
            if rate_cell.count() > 0:
                rate_cell.triple_click()
                rate_cell.fill(line["rate"])
                page.keyboard.press("Tab")
                page.wait_for_timeout(800)

            ss(page, f"create_04_line{idx+1}")

            # If more lines needed, click "Add line"
            if idx < len(REPLACEMENT_INVOICE["lines"]) - 1:
                add_line = page.locator(
                    "button:has-text('Add line'), a:has-text('Add line'), "
                    "[data-testid*='add-line'], button:has-text('Add lines')"
                ).first
                if add_line.count() > 0:
                    add_line.click()
                    page.wait_for_timeout(1500)

        except Exception as e:
            log(f"  Line {idx+1} error: {e}")

    ss(page, "create_05_lines_complete")

    # ── Screenshot before save — pause for manual review ─────────────────────
    log("\n  Invoice form filled. Review in browser.")
    log("  Verify:")
    log("    Customer: Sterling Subaru")
    log("    Date: 07/22/2026")
    log("    Line 1: Complete Detail / 2024 Subaru Crosstrek Silver #U761088 / $200")
    log("    Line 2: Complete Detail / 2023 Hyundai Tucson Red #U253409 / $200")
    log("    Total: $400.00")
    log("    Tax: Exempt")
    log(f"\n  If correct, touch {READY_F} to SAVE.")
    log("  If incorrect, fix manually then touch READY.")
    wait_for_ready()

    # ── Save ──────────────────────────────────────────────────────────────────
    log("\n  Saving invoice...")
    try:
        save_btn = page.locator(
            "button:has-text('Save and close'), button:has-text('Save and send'), "
            "button[aria-label*='Save' i]"
        ).first
        if save_btn.count() > 0:
            save_btn.click()
            page.wait_for_timeout(5000)
            log(f"  Saved. URL: {page.url}")
        else:
            # Try Save and close from dropdown
            page.keyboard.press("Tab")
            page.wait_for_timeout(500)
    except Exception as e:
        log(f"  Save error: {e}")

    ss(page, "create_06_saved")

    # Read the new invoice number from the saved page
    new_inv_num = None
    try:
        text = safe_text(page)
        m = re.search(r'Invoice\s+(?:No\.|#|Number)?\s*(\d{5,6})', text, re.IGNORECASE)
        if m:
            new_inv_num = m.group(1)
            log(f"  New invoice number: {new_inv_num}")
        m2 = re.search(r'txnId=(\d+)', page.url)
        txn = m2.group(1) if m2 else None
        log(f"  New txnId: {txn}")
    except Exception as e:
        log(f"  Could not read new invoice number: {e}")

    return new_inv_num


# ── PHASE 2: Full audit log investigation ─────────────────────────────────────

def fetch_audit_log_page(page, page_num):
    """Navigate to the given page of the QBO audit log and return all row text."""
    if page_num == 1:
        page.goto("https://qbo.intuit.com/app/auditlog",
                  wait_until="domcontentloaded", timeout=60000)
    else:
        # Try clicking the page number in pagination
        try:
            page.locator(f"[aria-label='Page {page_num}'], "
                         f"button:has-text('{page_num}'), "
                         f"a:has-text('{page_num}')").first.click()
        except:
            # Try "Next" button
            try:
                page.locator("button:has-text('Next'), a:has-text('Next'), "
                             "[aria-label='Next page']").first.click()
            except Exception as e:
                log(f"  Pagination error p{page_num}: {e}")

    # Dismiss any popup
    try:
        page.locator("button:has-text('×'), [aria-label='Close']").first.click(timeout=2000)
    except:
        pass

    page.wait_for_timeout(4000)
    text = safe_text(page)
    ss(page, f"auditlog_p{page_num:02d}")
    return text


def parse_audit_entries(text):
    """
    Extract audit log entries from page text.
    Returns list of dicts: {timestamp, user, event, invoice_num, customer, amount}
    """
    entries = []
    # Split on time pattern
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        # Look for timestamp lines
        ts_match = re.match(
            r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+,\s+\d+:\d+\s+(?:am|pm))',
            line, re.IGNORECASE
        )
        if ts_match:
            ts = ts_match.group(1)
            # Next non-empty line is the user
            j = i + 1
            while j < len(lines) and not lines[j].strip(): j += 1
            user = lines[j].strip() if j < len(lines) else ""
            # Next is the event
            k = j + 1
            while k < len(lines) and not lines[k].strip(): k += 1
            event = lines[k].strip() if k < len(lines) else ""

            # Parse invoice number, customer, amount from event
            inv_match = re.search(r'Invoice No\.\s*(\d+)', event)
            cust_match = re.search(r'for\s+(.+?)\s+for\s+\$', event)
            amt_match  = re.search(r'\$([\d,]+\.?\d*)', event)

            entry = {
                "timestamp": ts,
                "user": user,
                "event": event,
                "invoice_num": inv_match.group(1) if inv_match else None,
                "customer": cust_match.group(1).strip() if cust_match else None,
                "amount": amt_match.group(1) if amt_match else None,
            }
            entries.append(entry)
            i = k + 1
        else:
            i += 1
    return entries


def is_dealer(customer):
    if not customer: return False
    return any(p.lower() in customer.lower() for p in DEALER_PATTERNS)


def get_invoice_history(page, txn_id, label):
    """Fetch the full audit history for a given txnId."""
    url = f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}"
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    for _ in range(15):
        text = safe_text(page)
        if "Added by" in text or "Edited by" in text or len(text) > 3000:
            break
        page.wait_for_timeout(2000)
    text = safe_text(page)
    ss(page, f"hist_{label}")
    return text


def find_txn_id_for_invoice(page, invoice_num):
    """Open the invoice from the invoice list and return its txnId."""
    page.goto("https://qbo.intuit.com/app/invoices",
              wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(4000)

    result = page.evaluate(f"""() => {{
        const cells = Array.from(document.querySelectorAll('td, [class*="cell"]'));
        const target = cells.find(c => c.textContent.trim() === '{invoice_num}');
        if (!target) return null;
        let row = target.closest('tr, [class*="row"]');
        if (!row) row = target.parentElement?.parentElement;
        if (!row) return null;
        const link = row.querySelector('a[href*="txnId"]') || row.querySelector('a');
        return link ? link.href : null;
    }}""")

    if result:
        m = re.search(r'txnId=(\d+)', result)
        if m: return m.group(1)

    # Fallback: click the row
    try:
        cell = page.get_by_text(invoice_num, exact=True).first
        row_el = cell.locator("xpath=ancestor::tr[1]")
        link = row_el.locator("a").first
        if link.count() > 0:
            href = link.get_attribute("href") or ""
            m = re.search(r'txnId=(\d+)', href)
            if m: return m.group(1)
            link.click()
            page.wait_for_timeout(3000)
            m2 = re.search(r'txnId=(\d+)', page.url)
            if m2: return m2.group(1)
    except:
        pass
    return None


def full_investigation(page):
    log("\n" + "="*60)
    log("PHASE 2: Full audit log investigation")
    log("="*60)

    all_entries = []

    # Determine total pages
    page.goto("https://qbo.intuit.com/app/auditlog",
              wait_until="domcontentloaded", timeout=60000)
    try:
        page.locator("button:has-text('×'), [aria-label='Close']").first.click(timeout=2000)
    except: pass
    page.wait_for_timeout(5000)

    total_text = safe_text(page)
    total_match = re.search(r'(\d+)\s*-\s*(\d+)\s+of\s+(\d+)', total_text)
    if total_match:
        total_items = int(total_match.group(3))
        total_pages = (total_items + 49) // 50
        log(f"  Audit log: {total_items} entries, {total_pages} pages")
    else:
        total_pages = 9
        log(f"  Could not read total — assuming {total_pages} pages")

    # Page 1 is already loaded
    log(f"\n  Page 1/{total_pages}...")
    entries_p1 = parse_audit_entries(total_text)
    all_entries.extend(entries_p1)
    log(f"  Parsed {len(entries_p1)} entries from page 1")

    # Pages 2..N
    for pg in range(2, total_pages + 1):
        log(f"\n  Page {pg}/{total_pages}...")
        try:
            # Click the specific page number if visible
            pg_btn = page.locator(
                f"button:has-text('{pg}'):not([disabled]), "
                f"a:has-text('{pg}')"
            ).first
            if pg_btn.count() > 0:
                pg_btn.click()
            else:
                # Next button
                nxt = page.locator(
                    "button:has-text('Next'), a:has-text('Next'), "
                    "[aria-label='Next page'], [aria-label='next']"
                ).first
                nxt.click()
            page.wait_for_timeout(4000)
            ss(page, f"auditlog_p{pg:02d}")
            pg_text = safe_text(page)
            entries = parse_audit_entries(pg_text)
            all_entries.extend(entries)
            log(f"  Parsed {len(entries)} entries from page {pg}")
        except Exception as e:
            log(f"  Page {pg} error: {e}")

    log(f"\n  Total parsed: {len(all_entries)} audit log entries")

    # ── Build invoice timeline map ─────────────────────────────────────────────
    # Group entries by invoice number
    invoice_timeline = {}
    for e in all_entries:
        inv = e.get("invoice_num")
        if inv:
            invoice_timeline.setdefault(inv, []).append(e)

    log(f"  Unique invoice numbers in audit log: {len(invoice_timeline)}")

    # ── Find overwrite candidates ──────────────────────────────────────────────
    # Pattern: invoice created/touched by Pittstop Detail, then Edited by AutoLeap System
    # with a DIFFERENT customer after the edit
    overwrite_candidates = {}

    for inv_num, events in invoice_timeline.items():
        # Sort by timestamp (oldest first — we parse from newest, so reverse)
        # Actually entries are newest-first from QBO, so we reverse to get chronological
        chronological = list(reversed(events))

        pittstop_customers = set()
        autoleap_customers = set()
        pittstop_events = []
        autoleap_events = []

        for e in chronological:
            if "Pittstop Detail" in e["user"] or "pittstop" in e["user"].lower():
                if e["customer"]:
                    pittstop_customers.add(e["customer"])
                pittstop_events.append(e)
            elif "AutoLeap" in e["user"]:
                if e["customer"]:
                    autoleap_customers.add(e["customer"])
                autoleap_events.append(e)

        # Flag if:
        # 1. Pittstop created/edited it with a dealer customer
        # 2. AutoLeap later edited it with a different customer
        if pittstop_events and autoleap_events:
            dealer_pittstop = any(is_dealer(c) for c in pittstop_customers)
            al_customers_differ = autoleap_customers - pittstop_customers

            if dealer_pittstop and al_customers_differ:
                overwrite_candidates[inv_num] = {
                    "original_customers": list(pittstop_customers),
                    "autoleap_customers": list(autoleap_customers),
                    "pittstop_events": pittstop_events,
                    "autoleap_events": autoleap_events,
                    "is_dealer": True,
                }
                log(f"  OVERWRITE CANDIDATE: Invoice {inv_num} "
                    f"— Pittstop: {pittstop_customers} → AutoLeap: {autoleap_customers}")

        elif pittstop_events and is_dealer(next(iter(pittstop_customers), "")):
            # Pittstop dealer invoice — check if it has suspicious edit pattern
            # even without a clear customer change (maybe AutoLeap used same customer field)
            if autoleap_events:
                overwrite_candidates[inv_num] = {
                    "original_customers": list(pittstop_customers),
                    "autoleap_customers": list(autoleap_customers),
                    "pittstop_events": pittstop_events,
                    "autoleap_events": autoleap_events,
                    "is_dealer": True,
                    "note": "AutoLeap touched dealer invoice — check history",
                }
                log(f"  POSSIBLE CANDIDATE: Invoice {inv_num} "
                    f"— Pittstop: {pittstop_customers}, AutoLeap: {autoleap_customers}")

    log(f"\n  Overwrite candidates: {len(overwrite_candidates)}")

    # ── Get full audit history for each candidate ──────────────────────────────
    detailed_findings = {}

    for inv_num in sorted(overwrite_candidates.keys(), key=lambda x: int(x)):
        log(f"\n  Getting history for invoice {inv_num}...")
        txn_id = find_txn_id_for_invoice(page, inv_num)
        log(f"    txnId: {txn_id}")

        history_text = ""
        if txn_id:
            history_text = get_invoice_history(page, txn_id, f"inv{inv_num}")

        detailed_findings[inv_num] = {
            **overwrite_candidates[inv_num],
            "txn_id": txn_id,
            "history": history_text[:8000],
        }

    # ── Also specifically check Sterling Kia invoices ──────────────────────────
    log("\n  Checking for Sterling Kia invoices in full entry list...")
    sterling_kia_entries = [e for e in all_entries if e.get("customer")
                            and "Sterling Kia" in e.get("customer", "")]
    log(f"  Sterling Kia audit entries: {len(sterling_kia_entries)}")
    for e in sterling_kia_entries:
        log(f"    {e['timestamp']} | {e['user']} | {e['event'][:80]}")

    # ── Invoices where AutoLeap touches a Pittstop-created invoice ─────────────
    # Even if customer doesn't change — could be line items wiped
    autoleap_edits = [e for e in all_entries if "AutoLeap" in e.get("user","")
                      and "Edited Invoice" in e.get("event","")]
    log(f"\n  Total AutoLeap 'Edited Invoice' events: {len(autoleap_edits)}")
    for e in autoleap_edits:
        log(f"    {e['timestamp']} | Inv {e['invoice_num']} | {e['customer']} | ${e['amount']}")

    return {
        "all_entries_count": len(all_entries),
        "invoice_timeline": {k: v for k, v in invoice_timeline.items()},
        "overwrite_candidates": overwrite_candidates,
        "detailed_findings": detailed_findings,
        "sterling_kia_entries": sterling_kia_entries,
        "autoleap_edits": autoleap_edits,
    }


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    log("Starting full recovery + investigation run")

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS,
        )
        p = ctx.new_page()
        p.bring_to_front()

        log("\nNavigating to QBO...")
        p.goto("https://qbo.intuit.com", wait_until="domcontentloaded", timeout=30000)
        p.wait_for_timeout(3000)

        if "signin" in p.url.lower() or "accounts.intuit" in p.url.lower():
            log("QBO session expired — please log in.")
            wait_for_ready()
            p.wait_for_timeout(3000)

        log(f"  QBO: {p.url}")

        report = {}

        # ── PHASE 1: Create replacement invoice ───────────────────────────────
        new_invoice_num = create_replacement_invoice(p)
        report["replacement_invoice"] = {
            "original_was": "100803",
            "new_number": new_invoice_num,
            "customer": "Sterling Subaru",
            "date": "07/22/2026",
            "total": 400.00,
            "lines": REPLACEMENT_INVOICE["lines"],
        }

        # ── PHASE 2: Full investigation ────────────────────────────────────────
        investigation = full_investigation(p)
        report["investigation"] = investigation

        # ── Save report ───────────────────────────────────────────────────────
        with open(OUT, "w") as f:
            json.dump(report, f, indent=2, default=str)
        log(f"\nFull report → {OUT}")

        log("\nBrowser staying open for review.")
        log(f"Signal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()
        log("Done.")


if __name__ == "__main__":
    main()
