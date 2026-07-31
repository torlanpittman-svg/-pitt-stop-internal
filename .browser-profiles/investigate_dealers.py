"""
Systematic investigation of AutoLeap-overwritten dealer invoices.

Strategy:
  1. Audit log — change filter to "Last 12 months", page through ALL entries,
     extract every invoice touched by AutoLeap System.
  2. Invoice list — search for each dealer name (Sterling Kia, Sterling Subaru,
     Sterling Auto Group, etc.), get txnIds.
  3. Audit history — for every dealer invoice found, pull full history and detect
     any entry where a Pittstop Detail manual invoice was later replaced by
     AutoLeap with a different customer.
  4. Produce a complete report.
"""
import os, json, re, time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "dealer_investigation.json")

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

DEALER_NAMES = [
    "Sterling Subaru", "Sterling Kia", "Sterling Auto Group",
    "Sterling Auto", "Sterling BMW", "Sterling McCall",
]

def log(msg): print(msg, flush=True)

def ss(page, name):
    try: page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)
    except: pass

def safe_text(page):
    try: return page.inner_text("body")
    except: return ""

def wait_for_ready():
    if os.path.exists(READY_F):
        os.remove(READY_F); log("READY."); return
    log(f"Waiting:  touch {READY_F}")
    while not os.path.exists(READY_F): time.sleep(3)
    os.remove(READY_F); log("READY.")


# ── Audit log: full sweep ─────────────────────────────────────────────────────

def set_audit_log_date_filter(page, option_text="Last 12 months"):
    """Change the Date Changed dropdown on the audit log."""
    try:
        # Click the Date Changed dropdown
        date_dd = page.locator(
            "select[aria-label*='Date' i], "
            "[aria-label*='Date Changed' i], "
            "button:has-text('This Month'), "
            "button:has-text('Last'), "
            "[data-testid*='date-filter']"
        ).first
        if date_dd.count() > 0:
            tag = date_dd.evaluate("el => el.tagName")
            if tag == "SELECT":
                date_dd.select_option(label=option_text)
            else:
                date_dd.click()
                page.wait_for_timeout(1000)
                opt = page.locator(
                    f"[role='option']:has-text('{option_text}'), "
                    f"li:has-text('{option_text}')"
                ).first
                if opt.count() > 0:
                    opt.click()
                else:
                    log(f"  Option '{option_text}' not found in dropdown")
            page.wait_for_timeout(3000)
            log(f"  Date filter set to: {option_text}")
        else:
            log("  Date filter dropdown not found")
    except Exception as e:
        log(f"  Date filter error: {e}")


def parse_all_audit_entries(text):
    """
    Parse raw audit log body text into a list of entry dicts.
    QBO format (per entry):
      <Month Day, HH:MM pm Central Daylight Time>
      <tab> <User> <tab> <Event> <tab>
    """
    entries = []
    # Split on timestamp pattern — "Mon DD, HH:MM am/pm Central"
    pattern = re.compile(
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+'
        r'\d{1,2}:\d{2}\s+(?:am|pm)\s+Central\s+\w+\s+Time)',
        re.IGNORECASE
    )
    parts = pattern.split(text)
    i = 1  # parts[0] is header junk; odd indices are timestamps, even are content
    while i < len(parts) - 1:
        ts   = parts[i].strip()
        body = parts[i + 1].strip()
        # Body is tab-separated: user \t event \t (View or empty)
        cells = [c.strip() for c in re.split(r'\t+|\n\s*\n', body) if c.strip()]
        user  = cells[0] if len(cells) > 0 else ""
        event = cells[1] if len(cells) > 1 else ""

        inv_m  = re.search(r'Invoice No\.\s*(\d+)', event)
        # "Edited Invoice No. 100803 for Maria Houchins for $2148.40"
        cust_m = re.search(r'(?:Invoice No\.\s*\d+\s+for\s+|to\s+)(.+?)\s+for\s+\$', event)
        amt_m  = re.search(r'\$([\d,]+\.?\d*)', event)

        entries.append({
            "timestamp": ts,
            "user":      user,
            "event":     event,
            "invoice_num": inv_m.group(1) if inv_m else None,
            "customer":  cust_m.group(1).strip() if cust_m else None,
            "amount":    amt_m.group(1) if amt_m else None,
        })
        i += 2
    return entries


def fetch_all_audit_entries(page):
    """Navigate audit log, set date to 12 months, page through all results."""
    log("\n── Full audit log sweep ──")

    page.goto("https://qbo.intuit.com/app/auditlog",
              wait_until="domcontentloaded", timeout=60000)
    try:
        page.locator("button:has-text('×'), [aria-label='Close']").first.click(timeout=2000)
    except: pass
    page.wait_for_timeout(4000)

    # Expand date range
    set_audit_log_date_filter(page, "Last 12 months")
    ss(page, "inv_audit_p01")

    page.wait_for_timeout(3000)
    total_text = safe_text(page)
    total_m = re.search(r'(\d+)\s*-\s*(\d+)\s+of\s+([\d,]+)', total_text)
    if total_m:
        total_items = int(total_m.group(3).replace(",", ""))
        total_pages = max(9, (total_items + 49) // 50)
        log(f"  {total_items} entries across ~{total_pages} pages")
    else:
        total_pages = 9
        log(f"  Could not read total, using {total_pages}")

    all_entries = parse_all_audit_entries(total_text)
    log(f"  Page 1: {len(all_entries)} entries")

    for pg in range(2, total_pages + 1):
        try:
            nxt = page.locator(
                "button[aria-label='Next page'], "
                "button[aria-label='next'], "
                "button:has-text('Next'):not([disabled]), "
                "a:has-text('Next')"
            ).last
            if nxt.count() == 0 or not nxt.is_enabled():
                log(f"  No Next button on page {pg-1} — stopping")
                break
            nxt.scroll_into_view_if_needed()
            nxt.click()
            page.wait_for_timeout(4000)
            ss(page, f"inv_audit_p{pg:02d}")
            pg_text = safe_text(page)
            pg_entries = parse_all_audit_entries(pg_text)
            all_entries.extend(pg_entries)
            log(f"  Page {pg}: {len(pg_entries)} entries (running total: {len(all_entries)})")
        except Exception as e:
            log(f"  Page {pg} pagination error: {e}")
            break

    log(f"  TOTAL AUDIT LOG ENTRIES: {len(all_entries)}")
    return all_entries


# ── Invoice list: search by dealer ────────────────────────────────────────────

def get_invoice_list_for_customer(page, customer_name):
    """
    Search the QBO invoice list for a customer and return rows with
    invoice number, date, amount, status, and txnId.
    """
    log(f"\n── Invoice list: {customer_name} ──")
    page.goto("https://qbo.intuit.com/app/invoices",
              wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(3000)

    # Use the global search to find invoices for this customer
    results = []
    try:
        # Try to filter by customer in the invoice list search/filter
        # QBO invoice list has a search bar in the top
        search = page.locator(
            "input[aria-label*='search' i]:not([aria-label*='global' i]), "
            "input[placeholder*='Search' i]"
        ).first
        if search.count() > 0:
            search.fill(customer_name)
            page.wait_for_timeout(3000)
        ss(page, f"invlist_{customer_name.replace(' ', '_')[:20]}")

        # Extract rows
        rows_data = page.evaluate(f"""() => {{
            const rows = [];
            document.querySelectorAll('tr[data-row-index], tbody tr').forEach(tr => {{
                const cells = [...tr.querySelectorAll('td')].map(c => c.textContent.trim());
                const text = tr.textContent;
                if (text.includes('{customer_name.split()[0]}')) {{
                    // Get View/Edit link href for txnId
                    const link = tr.querySelector('a[href*="txnId"]');
                    const href  = link ? link.href : '';
                    const m     = href.match(/txnId=(\\d+)/);
                    rows.push({{
                        cells: cells.slice(0, 8),
                        href:  href,
                        txnId: m ? m[1] : null,
                        text:  text.slice(0, 200),
                    }});
                }}
            }});
            return rows;
        }}""")
        results = rows_data
        log(f"  Found {len(results)} rows for {customer_name}")
        for r in results[:10]:
            log(f"    txnId={r.get('txnId')} | {r.get('text','')[:80]}")
    except Exception as e:
        log(f"  Invoice list search error for {customer_name}: {e}")

    return results


# ── Audit history for a single invoice ───────────────────────────────────────

def get_audit_history(page, txn_id, label=""):
    url = f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}"
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    for _ in range(15):
        t = safe_text(page)
        if "Added by" in t or "Edited by" in t or len(t) > 3000: break
        page.wait_for_timeout(2000)
    text = safe_text(page)
    if label:
        ss(page, f"hist_{label}")
    return text


def parse_history_versions(history_text):
    """
    Extract all version snapshots from a QBO audit history page.
    Returns list of {timestamp, actor, customer, amount, event_type}
    """
    versions = []
    ts_pattern = re.compile(
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{1,2}:\d{2}'
        r'\s+(?:am|pm)\s+Central[^:]+):\s+(\w+(?:\s+\w+)*)\s+by\s+(.+)',
        re.IGNORECASE
    )
    for m in ts_pattern.finditer(history_text):
        ts        = m.group(1).strip()
        action    = m.group(2).strip()   # "Edited", "Added", "Indirect edit"
        actor     = m.group(3).strip()   # "Pittstop Detail", "AutoLeap System", etc.

        # Find the Name (customer) in the block after this timestamp
        start = m.end()
        end   = history_text.find("\n" + ts_pattern.pattern[:10], start)
        block = history_text[start:end if end > 0 else start + 3000]

        name_m  = re.search(r'\bName:\s*\n([^\n]+)', block)
        amt_m   = re.search(r'\bAmount:\s*\n([\d,.\s]+)', block)
        # QBO shows old/new value on separate lines for changed fields
        name    = name_m.group(1).strip() if name_m else None
        amount  = amt_m.group(1).strip().split("\n")[0] if amt_m else None

        versions.append({
            "timestamp": ts,
            "action":    action,
            "actor":     actor,
            "customer":  name,
            "amount":    amount,
        })
    return versions


def detect_overwrite(versions, invoice_num):
    """
    Given the list of versions for an invoice, detect if AutoLeap overwrote
    a Pittstop Detail manual entry.
    Returns dict with findings, or None.
    """
    if not versions: return None

    pittstop_versions = [v for v in versions if "Pittstop" in v.get("actor","")]
    autoleap_versions = [v for v in versions if "AutoLeap" in v.get("actor","")]

    if not (pittstop_versions and autoleap_versions): return None

    # Original customer: take the first Pittstop version (earliest = last in list since
    # QBO audit history is newest-first)
    original = pittstop_versions[-1]
    final_autoleap = autoleap_versions[0]  # most recent AutoLeap action

    original_customer = original.get("customer","")
    autoleap_customer = final_autoleap.get("customer","")

    customer_changed = (
        original_customer and autoleap_customer and
        original_customer.lower() != autoleap_customer.lower()
    )

    return {
        "invoice_num":        invoice_num,
        "original_customer":  original_customer,
        "original_timestamp": original.get("timestamp",""),
        "original_amount":    original.get("amount",""),
        "autoleap_customer":  autoleap_customer,
        "autoleap_timestamp": final_autoleap.get("timestamp",""),
        "autoleap_amount":    final_autoleap.get("amount",""),
        "customer_changed":   customer_changed,
        "all_versions":       versions,
    }


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    log("Dealer invoice overwrite investigation")

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

        report = {
            "confirmed_overwrites": [],
            "suspicious_invoices":  [],
            "clean_dealer_invoices":[],
            "audit_log_summary":    {},
            "raw_autoleap_edits":   [],
        }

        # ── Step 1: Full audit log sweep ──────────────────────────────────────
        all_entries = fetch_all_audit_entries(p)

        # Summarise AutoLeap edits
        al_edits = [e for e in all_entries
                    if "AutoLeap" in e.get("user","")
                    and "Edited Invoice" in e.get("event","")]
        log(f"\n  All AutoLeap 'Edited Invoice' events: {len(al_edits)}")
        for e in al_edits:
            log(f"    {e['timestamp'][:20]} | #{e['invoice_num']} | "
                f"{e['customer']} | ${e['amount']}")
        report["raw_autoleap_edits"] = al_edits

        # Unique invoice numbers AutoLeap touched
        al_invoice_nums = list({e["invoice_num"] for e in al_edits if e.get("invoice_num")})
        log(f"\n  Unique invoices AutoLeap edited: {al_invoice_nums}")

        # ── Step 2: Search invoice list for all dealer customers ──────────────
        all_dealer_invoices = {}  # txnId → {invoice_num, customer, ...}

        for dealer in DEALER_NAMES:
            rows = get_invoice_list_for_customer(p, dealer)
            for r in rows:
                txn = r.get("txnId")
                if txn:
                    all_dealer_invoices[txn] = {"source_search": dealer, "row": r}

        log(f"\n  Total dealer invoice txnIds found: {len(all_dealer_invoices)}")

        # Also add any invoice that AutoLeap edited that we haven't seen yet
        # (these would be the CURRENT view — might show wrong customer now)
        for inv_num in al_invoice_nums:
            if inv_num:
                # Check if this invoice number is in dealer list
                already = any(
                    inv_num in str(v.get("row",{}).get("text",""))
                    for v in all_dealer_invoices.values()
                )
                if not already:
                    log(f"  AutoLeap-edited invoice {inv_num} not in dealer search — "
                        f"will look up directly")
                    try:
                        p.goto("https://qbo.intuit.com/app/invoices",
                               wait_until="domcontentloaded", timeout=30000)
                        p.wait_for_timeout(3000)
                        txn = None
                        result = p.evaluate(f"""() => {{
                            const cells = Array.from(
                                document.querySelectorAll('td, [class*="cell"]'));
                            const t = cells.find(c => c.textContent.trim()==='{inv_num}');
                            if (!t) return null;
                            let row = t.closest('tr, [class*="row"]');
                            if (!row) return null;
                            const a = row.querySelector('a[href*="txnId"]');
                            return a ? a.href : null;
                        }}""")
                        if result:
                            m = re.search(r'txnId=(\d+)', result)
                            if m:
                                txn = m.group(1)
                                all_dealer_invoices[txn] = {
                                    "source_search": f"autoleap_edit_{inv_num}",
                                    "inv_num": inv_num,
                                }
                    except Exception as e:
                        log(f"  Direct lookup error for {inv_num}: {e}")

        # ── Step 3: Get audit history for every dealer invoice ─────────────────
        log(f"\n── Getting audit history for {len(all_dealer_invoices)} dealer invoices ──")

        for txn_id, meta in list(all_dealer_invoices.items())[:40]:  # cap at 40
            inv_tag = meta.get("inv_num") or meta.get("source_search","?")
            log(f"\n  txnId={txn_id} ({inv_tag})")
            try:
                history = get_audit_history(p, txn_id, f"txn{txn_id}")
                versions = parse_history_versions(history)
                log(f"    Versions: {len(versions)}")
                for v in versions:
                    log(f"    {v['timestamp'][:20]} | {v['actor'][:30]} | "
                        f"{v['action']} | cust={v.get('customer','?')} | "
                        f"amt={v.get('amount','?')}")

                finding = detect_overwrite(versions, txn_id)
                if finding:
                    if finding["customer_changed"]:
                        log(f"  *** CONFIRMED OVERWRITE: {finding['original_customer']} "
                            f"→ {finding['autoleap_customer']} ***")
                        report["confirmed_overwrites"].append(finding)
                    else:
                        log(f"  SUSPICIOUS (AutoLeap touched, no customer change)")
                        report["suspicious_invoices"].append({
                            "txn_id": txn_id,
                            "versions": versions,
                        })
                else:
                    report["clean_dealer_invoices"].append(txn_id)

            except Exception as e:
                log(f"  History error: {e}")

        # ── Step 4: Report ─────────────────────────────────────────────────────
        log("\n" + "="*60)
        log("INVESTIGATION REPORT")
        log("="*60)
        log(f"\nConfirmed overwrites: {len(report['confirmed_overwrites'])}")
        for o in report["confirmed_overwrites"]:
            log(f"  txnId {o['txn_id']} | {o['original_customer']} "
                f"(${o['original_amount']}) → {o['autoleap_customer']} "
                f"(${o['autoleap_amount']})")

        log(f"\nSuspicious (AutoLeap touched, customer unchanged): "
            f"{len(report['suspicious_invoices'])}")

        log(f"\nClean dealer invoices: {len(report['clean_dealer_invoices'])}")

        with open(OUT, "w") as f:
            json.dump(report, f, indent=2, default=str)
        log(f"\nReport → {OUT}")

        log(f"\nSignal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()
        log("Done.")


if __name__ == "__main__":
    main()
