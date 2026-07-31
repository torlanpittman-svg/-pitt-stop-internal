"""
Forensic read-only check for invoices 100773 and 100775.

These invoice numbers did not map to the expected txnIds — the offset formula
returned a Sales Receipt (100797/txnId 23114) and a Payment (txnId 23116).
The actual invoices must be found via:

  1. QBO global search by invoice number
  2. QBO invoice list with broader date filter
  3. QBO audit log search for invoice number strings
  4. Wide txnId scan verifying invoice number on each page

Known txnId anchor: Invoice 100802 = 23143, Invoice 100803 = 23144
Sales Receipt 100797 = txnId 23114 (from prior run)
Invoice 100799 = txnId 23136

SAFETY: Read-only. No creates, edits, voids, or deletes.
"""
import os, json, re, time
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "forensic_100773_100775.json")
LOG     = "/tmp/audit_hist.log"

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

TARGETS = ["100773", "100775"]

DEALER_KEYWORDS = {"sterling", "auto group", "kia", "subaru", "hyundai", "toyota",
                   "honda", "ford", "chevrolet", "chevy", "nissan", "dealer"}

def logmsg(msg):
    with open(LOG, "a") as f:
        f.write(msg + "\n")

def ss(page, name):
    try: page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)
    except: pass

def safe_text(page):
    try: return page.inner_text("body")
    except: return ""

def wait_for_ready():
    if os.path.exists(READY_F):
        os.remove(READY_F); logmsg("READY."); return
    logmsg(f"Waiting:  touch {READY_F}")
    while not os.path.exists(READY_F): time.sleep(3)
    os.remove(READY_F); logmsg("READY.")

def is_dealer(text):
    if not text: return False
    return any(k in text.lower() for k in DEALER_KEYWORDS)

def wait_for_content(page, keywords, max_wait=40):
    for i in range(max_wait // 2):
        t = safe_text(page)
        if any(k in t for k in keywords) or len(t) > 4000:
            return t
        page.wait_for_timeout(2000)
    return safe_text(page)


# ── Strategy 1: QBO global search ─────────────────────────────────────────────

def search_global(page, inv_num):
    """Use QBO's global search bar to find an invoice by number."""
    logmsg(f"  [Strategy 1] Global search for '{inv_num}'")
    page.goto("https://qbo.intuit.com/app/homepage", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)
    ss(page, f"forensic_{inv_num}_homepage")

    try:
        # QBO global search — the magnifying glass / search input
        search = page.locator(
            "input[placeholder*='Search'], input[placeholder*='Find'], "
            "input[aria-label*='Search'], [class*='GlobalSearch'] input, "
            "input[data-testid*='search']"
        ).first
        if search.count() == 0:
            # Try clicking the search icon first
            page.locator("[aria-label*='Search'], [class*='search-icon'], "
                         "button[title*='Search']").first.click(timeout=3000)
            page.wait_for_timeout(1000)
            search = page.locator("input[placeholder*='Search'], input[type='search']").first

        search.fill(inv_num)
        page.wait_for_timeout(2000)
        page.keyboard.press("Enter")
        page.wait_for_timeout(3000)
        ss(page, f"forensic_{inv_num}_search_result")

        text = safe_text(page)
        if inv_num in text:
            logmsg(f"    Found '{inv_num}' in global search results")
            # Try clicking the first result that mentions this invoice
            clicked = page.evaluate(f"""() => {{
                const els = Array.from(document.querySelectorAll('a, [role=link], [role=button]'));
                const el = els.find(e => e.textContent.includes('{inv_num}'));
                if (el) {{ el.click(); return true; }}
                return false;
            }}""")
            if clicked:
                page.wait_for_timeout(4000)
                url = page.url
                m = re.search(r'txnId=(\d+)', url)
                if m:
                    logmsg(f"    txnId from URL: {m.group(1)}")
                    return int(m.group(1)), page.url
        else:
            logmsg(f"    Not found in global search")
    except Exception as e:
        logmsg(f"    Global search error: {e}")

    return None, None


# ── Strategy 2: Invoice list with "All" date filter ────────────────────────────

def search_invoice_list(page, inv_num):
    """Open invoice list, change filter to All, search for invoice number."""
    logmsg(f"  [Strategy 2] Invoice list search for '{inv_num}'")
    page.goto("https://qbo.intuit.com/app/invoices", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(4000)
    ss(page, f"forensic_{inv_num}_invoicelist_before")

    # Try to change the date filter to "All dates" or "All time"
    try:
        date_filter = page.locator(
            "button:has-text('This month'), button:has-text('Last 30'), "
            "button:has-text('Date'), select[aria-label*='date'], "
            "[class*='DateRange'], [class*='dateRange']"
        ).first
        if date_filter.count() > 0:
            date_filter.click()
            page.wait_for_timeout(1000)
            # Try to select "All" option
            all_opt = page.locator("li:has-text('All'), option:has-text('All'), [role=option]:has-text('All')").first
            if all_opt.count() > 0:
                all_opt.click()
                page.wait_for_timeout(2000)
                logmsg(f"    Set date filter to All")
    except Exception as e:
        logmsg(f"    Date filter error (non-fatal): {e}")

    # Try the search/filter input within the invoice list
    try:
        search_inp = page.locator(
            "input[placeholder*='Number'], input[placeholder*='Search'], "
            "input[aria-label*='invoice number'], input[type='search']"
        ).first
        if search_inp.count() > 0:
            search_inp.fill(inv_num)
            page.wait_for_timeout(2000)
            ss(page, f"forensic_{inv_num}_invoicelist_filtered")
    except Exception as e:
        logmsg(f"    List search error: {e}")

    # Check if the invoice number appears in the page
    text = safe_text(page)
    if inv_num in text:
        logmsg(f"    Found '{inv_num}' in invoice list")
        # Try clicking on it
        result = page.evaluate(f"""() => {{
            const all = Array.from(document.querySelectorAll('td, span, div, a'));
            const cell = all.find(e => e.children.length === 0 && e.textContent.trim() === '{inv_num}');
            if (!cell) return null;
            const row = cell.closest('tr') || cell.closest('[class*="row"]') || cell.parentElement?.parentElement;
            if (!row) return null;
            const link = row.querySelector('a[href*="txnId"]') || row.querySelector('a');
            if (link && link.href && link.href.includes('txnId')) return link.href;
            if (link) {{ link.click(); return 'clicked'; }}
            cell.click();
            return 'cell_clicked';
        }}""")

        logmsg(f"    Click result: {result}")
        if result and 'txnId=' in str(result):
            m = re.search(r'txnId=(\d+)', str(result))
            if m:
                return int(m.group(1)), result
        elif result in ('clicked', 'cell_clicked'):
            page.wait_for_timeout(4000)
            url = page.url
            m = re.search(r'txnId=(\d+)', url)
            if m:
                return int(m.group(1)), url
    else:
        logmsg(f"    Invoice {inv_num} not visible in list")

    return None, None


# ── Strategy 3: Audit log search ──────────────────────────────────────────────

def search_audit_log(page, inv_num):
    """Look in the QBO audit log for any entry mentioning this invoice number."""
    logmsg(f"  [Strategy 3] Audit log scan for '{inv_num}'")
    page.goto("https://qbo.intuit.com/app/auditlog", wait_until="domcontentloaded", timeout=60000)
    try:
        page.locator("button:has-text('×'), [aria-label='Close']").first.click(timeout=2000)
    except: pass
    page.wait_for_timeout(5000)
    ss(page, f"forensic_{inv_num}_auditlog")

    # Page through audit log looking for the invoice number
    pages_searched = 0
    for pg in range(1, 10):
        text = safe_text(page)
        if inv_num in text:
            logmsg(f"    Found '{inv_num}' in audit log page {pg}")
            # Extract txnId from surrounding context
            # Audit log entries have a "History" link that may contain txnId
            txn_found = page.evaluate(f"""() => {{
                const links = Array.from(document.querySelectorAll('a'));
                const relevant = links.filter(l =>
                    l.textContent.includes('{inv_num}') ||
                    (l.closest('tr') || l.closest('[class*=row]') || l.parentElement?.parentElement)?.textContent?.includes('{inv_num}')
                );
                for (const l of relevant) {{
                    if (l.href && l.href.includes('txnId')) return l.href;
                }}
                return null;
            }}""")

            if txn_found:
                m = re.search(r'txnId=(\d+)', txn_found)
                if m:
                    logmsg(f"    txnId from audit log link: {m.group(1)}")
                    return int(m.group(1)), txn_found

            # Try clicking the View/History link in the row containing the invoice number
            clicked = page.evaluate(f"""() => {{
                const rows = Array.from(document.querySelectorAll('tr, [class*=row]'));
                const row = rows.find(r => r.textContent.includes('{inv_num}'));
                if (!row) return false;
                const link = Array.from(row.querySelectorAll('a, button')).find(l =>
                    (l.textContent || '').trim().toLowerCase().includes('view') ||
                    (l.textContent || '').trim().toLowerCase().includes('history')
                );
                if (link) {{ link.click(); return true; }}
                return false;
            }}""")

            if clicked:
                page.wait_for_timeout(4000)
                url = page.url
                m = re.search(r'txnId=(\d+)', url)
                if m:
                    logmsg(f"    txnId from audit log click: {m.group(1)}")
                    return int(m.group(1)), url

        # Go to next page
        pages_searched += 1
        advanced = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button, [role=button], a'));
            const nxt = btns.find(b => {
                const t = (b.textContent || '').trim();
                const a = (b.getAttribute('aria-label') || '').toLowerCase();
                return t === '›' || t === 'Next' || a.includes('next');
            });
            if (!nxt) return false;
            nxt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
            return true;
        }""")

        if not advanced:
            logmsg(f"    Audit log: no more pages after {pg}")
            break
        page.wait_for_timeout(4000)

    logmsg(f"    Not found in audit log ({pages_searched} pages)")
    return None, None


# ── Strategy 4: Wide txnId scan ───────────────────────────────────────────────

def scan_txn_range(page, inv_num, center, radius=60):
    """
    Scan txnIds from center-radius to center+radius looking for the invoice.
    Verifies by checking the page for 'Invoice No. {inv_num}' or 'No. {inv_num}'.
    """
    logmsg(f"  [Strategy 4] Scanning txnId range {center-radius}–{center+radius} for inv {inv_num}")
    # Search outward from center
    candidates = []
    for delta in range(0, radius + 1):
        for sign in ([0] if delta == 0 else [delta, -delta]):
            candidates.append(center + sign)

    for txn_id in candidates:
        try:
            page.goto(f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}",
                      wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(1500)
            text = safe_text(page)

            # Check if this is the right invoice
            if (f"Invoice No. {inv_num}" in text or
                    f"No. {inv_num}" in text or
                    f"Num:\t\n{inv_num}" in text):
                logmsg(f"    FOUND Invoice {inv_num} at txnId={txn_id} (delta={txn_id - center:+d})")
                return txn_id, text
        except Exception as e:
            continue

    logmsg(f"    Not found in txnId scan range")
    return None, None


# ── Audit history parser ───────────────────────────────────────────────────────

def get_full_audit_history(page, txn_id):
    """Fetch audit history and wait for content to load."""
    page.goto(f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}",
              wait_until="domcontentloaded", timeout=45000)
    text = wait_for_content(page, ["Added by", "Edited by", "Deleted by"])
    return text


def parse_history(text):
    versions = []
    snap_re = re.compile(
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+'
        r'\d{1,2}:\d{2}\s+(?:am|pm)[^:]+):\s+(.+)',
        re.MULTILINE
    )
    for m in snap_re.finditer(text):
        ts   = m.group(1).strip()
        desc = m.group(2).strip()
        actor_m = re.search(r'by\s+(.+)', desc)
        actor   = actor_m.group(1).strip() if actor_m else desc
        action  = desc.split(" by ")[0].strip()

        start = m.end()
        nxt   = snap_re.search(text, start)
        block = text[start: nxt.start() if nxt else start + 8000]

        name_m  = re.search(r'\nName:\s*\n(.*?)(?:\n|$)', block)
        amt_m   = re.search(r'\nAmount:\s*\n([\d,.\s]+)', block)
        date_m  = re.search(r'\nDate:\s*\n([^\n]+)', block)
        memo_m  = re.search(r'AutoLeap Order.*', block)

        name_raw = name_m.group(1).strip() if name_m else ""
        name_lines = [l.strip() for l in name_raw.split("\n") if l.strip()]
        name_final = name_lines[-1] if name_lines else ""

        versions.append({
            "timestamp": ts,
            "action":    action,
            "actor":     actor,
            "customer":  name_final,
            "amount":    (amt_m.group(1).strip().split()[0] if amt_m else ""),
            "date":      (date_m.group(1).strip() if date_m else ""),
            "memo":      (memo_m.group(0)[:120] if memo_m else ""),
        })
    return versions


def extract_key_facts(text, inv_num):
    """Extract invoice-level facts from audit history page."""
    facts = {
        "invoice_num_confirmed": inv_num in text,
        "transaction_type": "",
        "customers_seen":   [],
        "amounts_seen":     [],
        "autoleap_memo":    "",
        "payment_attached": False,
        "voided":           False,
        "deleted":          False,
    }

    # Transaction type
    for t in ["Invoice", "Sales Receipt", "Payment", "Credit Memo", "Estimate"]:
        type_m = re.search(rf'\nType:\s*\n{t}', text)
        if type_m:
            facts["transaction_type"] = t
            break

    # All customer/name values seen
    facts["customers_seen"] = list(set(re.findall(r'\nName:\s*\n([^\n]+)', text)))
    facts["amounts_seen"]   = list(set(re.findall(r'\nAmount:\s*\n([\d,\.]+)', text)))

    # AutoLeap memo content
    al_memo = re.search(r'AutoLeap Order[^:]*:\s*[^\n]+', text)
    if al_memo: facts["autoleap_memo"] = al_memo.group(0)[:200]

    # Payment references
    if "Payment" in text and ("applied" in text.lower() or "Accounts Receivable" in text):
        facts["payment_attached"] = True

    if "Deleted" in text:   facts["deleted"] = True
    if "Voided" in text:    facts["voided"]  = True

    return facts


# ── Main ──────────────────────────────────────────────────────────────────────

def investigate_invoice(page, inv_num):
    logmsg(f"\n{'='*60}")
    logmsg(f"FORENSIC CHECK: Invoice {inv_num}")
    logmsg(f"{'='*60}")

    result = {
        "invoice_num":  inv_num,
        "txn_id":       None,
        "found":        False,
        "strategies_tried": [],
        "transaction_type": "",
        "is_dealer":    False,
        "customers":    [],
        "amounts":      [],
        "versions":     [],
        "autoleap_involved": False,
        "autoleap_memo": "",
        "deleted":      False,
        "voided":       False,
        "payment_attached": False,
        "verdict":      "",
        "confidence":   "",
        "notes":        [],
        "raw_history":  "",
    }

    txn_id = None
    history_text = ""

    # Strategy 1: global search
    txn_id, url = search_global(page, inv_num)
    result["strategies_tried"].append("global_search")
    if txn_id:
        logmsg(f"  Found via global search: txnId={txn_id}")

    # Strategy 2: invoice list
    if not txn_id:
        txn_id, url = search_invoice_list(page, inv_num)
        result["strategies_tried"].append("invoice_list")
        if txn_id:
            logmsg(f"  Found via invoice list: txnId={txn_id}")

    # Strategy 3: audit log
    if not txn_id:
        txn_id, url = search_audit_log(page, inv_num)
        result["strategies_tried"].append("audit_log")
        if txn_id:
            logmsg(f"  Found via audit log: txnId={txn_id}")

    # Strategy 4: wide txnId scan
    # Center on the known ranges:
    # Invoice 100799 → txnId 23136, Sales Receipt 100797 → 23114
    # For inv 100773: roughly 24 docs before 100797. With large inter-doc gaps, center around 22900
    # For inv 100775: roughly 22 docs before 100797, center around 23000
    if not txn_id:
        if inv_num == "100773":
            # Try two center points based on different interpolations
            center_a = 22900  # aggressive estimate (more gaps)
            center_b = 23060  # conservative estimate (fewer gaps)
        else:  # 100775
            center_a = 23000
            center_b = 23080

        for center in [center_a, center_b]:
            txn_id, history_text = scan_txn_range(page, inv_num, center, radius=80)
            result["strategies_tried"].append(f"txn_scan_c{center}")
            if txn_id:
                logmsg(f"  Found via txnId scan: txnId={txn_id}")
                break

    if not txn_id:
        logmsg(f"  NOT FOUND by any strategy")
        result["verdict"]     = "NOT_FOUND"
        result["confidence"]  = "LOW"
        result["notes"].append("Invoice number not found in QBO via any search method")
        return result

    result["txn_id"] = txn_id
    result["found"]  = True

    # Get full audit history if we don't already have it from the scan
    if not history_text:
        history_text = get_full_audit_history(page, txn_id)
    ss(page, f"forensic_{inv_num}_history")

    # Verify we have the right invoice
    if (f"Invoice No. {inv_num}" not in history_text and
            f"No. {inv_num}" not in history_text and
            f"Num:\t\n{inv_num}" not in history_text):
        logmsg(f"  WARNING: txnId={txn_id} may not be invoice {inv_num} — verifying content")
        # Still parse and note the discrepancy
        result["notes"].append(f"Invoice number {inv_num} not confirmed in page text at txnId={txn_id}")

    # Extract facts
    facts = extract_key_facts(history_text, inv_num)
    result["transaction_type"]  = facts["transaction_type"]
    result["customers"]         = facts["customers_seen"]
    result["amounts"]           = facts["amounts_seen"]
    result["autoleap_memo"]     = facts["autoleap_memo"]
    result["deleted"]           = facts["deleted"]
    result["voided"]            = facts["voided"]
    result["payment_attached"]  = facts["payment_attached"]

    # Parse version history
    versions = parse_history(history_text)
    result["versions"] = versions

    ps_vs  = [v for v in versions if "Pittstop" in v["actor"]]
    al_vs  = [v for v in versions if "AutoLeap" in v["actor"]]
    sys_vs = [v for v in versions if "System" in v["actor"] and "AutoLeap" not in v["actor"]]

    result["autoleap_involved"] = len(al_vs) > 0
    result["is_dealer"] = any(is_dealer(c) for c in facts["customers_seen"])

    logmsg(f"\n  Transaction type: {facts['transaction_type']}")
    logmsg(f"  Is dealer: {result['is_dealer']}")
    logmsg(f"  Customers seen: {facts['customers_seen']}")
    logmsg(f"  Amounts seen: {facts['amounts_seen']}")
    logmsg(f"  Deleted: {facts['deleted']} | Voided: {facts['voided']}")
    logmsg(f"  AutoLeap involved: {result['autoleap_involved']}")
    if facts["autoleap_memo"]:
        logmsg(f"  AutoLeap memo: {facts['autoleap_memo']}")

    logmsg(f"\n  Version history ({len(versions)} entries):")
    for v in versions[:10]:
        logmsg(f"    {v['timestamp'][:26]} | {v['actor'][:22]} | {v['action']} "
               f"| cust={v['customer'][:28]} | ${v['amount']}")

    # Determine verdict
    if not facts["invoice_num_confirmed"]:
        result["verdict"]    = "WRONG_TXNID"
        result["confidence"] = "LOW"
        result["notes"].append("Content does not confirm this is the right invoice")
    elif facts["deleted"]:
        result["verdict"]    = "DELETED"
        result["confidence"] = "HIGH"
        del_v = next((v for v in versions if "Deleted" in v["action"]), {})
        result["notes"].append(f"Deleted by {del_v.get('actor','?')} at {del_v.get('timestamp','?')}")
    elif facts["voided"]:
        result["verdict"]    = "VOIDED"
        result["confidence"] = "HIGH"
    elif al_vs and ps_vs:
        orig_cust = ps_vs[-1]["customer"]
        al_cust   = al_vs[0]["customer"]
        if orig_cust and al_cust and orig_cust.lower() != al_cust.lower():
            result["verdict"]    = "OVERWRITTEN_BY_AUTOLEAP"
            result["confidence"] = "HIGH"
            result["notes"].append(
                f"Original customer (Pittstop): {orig_cust}  →  "
                f"AutoLeap replaced with: {al_cust}"
            )
        else:
            result["verdict"]    = "AUTOLEAP_TOUCHED_SAME_CUSTOMER"
            result["confidence"] = "MEDIUM"
    elif al_vs and not ps_vs:
        result["verdict"]    = "AUTOLEAP_CREATED"
        result["confidence"] = "HIGH"
        result["notes"].append("AutoLeap created this invoice; no Pittstop Detail version exists")
    elif ps_vs and not al_vs:
        result["verdict"]    = "CLEAN_PITTSTOP_ONLY"
        result["confidence"] = "HIGH"
    else:
        result["verdict"]    = "UNKNOWN"
        result["confidence"] = "LOW"

    logmsg(f"\n  VERDICT: {result['verdict']}  ({result['confidence']} confidence)")
    for note in result["notes"]:
        logmsg(f"  NOTE: {note}")

    result["raw_history"] = history_text[:6000]
    return result


def main():
    logmsg("\nForensic read-only check: invoices 100773 and 100775")
    logmsg("Safety: read-only — no creates, edits, voids, or deletes\n")

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS,
        )
        p = ctx.new_page()
        p.bring_to_front()

        p.goto("https://qbo.intuit.com", wait_until="domcontentloaded", timeout=30000)
        p.wait_for_timeout(3000)
        if "signin" in p.url.lower() or "accounts.intuit" in p.url.lower():
            logmsg("QBO session expired — please log in.")
            wait_for_ready()
            p.wait_for_timeout(3000)
        logmsg(f"  QBO: {p.url}\n")

        report = {}
        for inv in TARGETS:
            report[inv] = investigate_invoice(p, inv)

        with open(OUT, "w") as f:
            json.dump(report, f, indent=2, default=str)
        logmsg(f"\nReport saved → {OUT}")
        logmsg("FORENSIC COMPLETE")

        logmsg(f"\nSignal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()


if __name__ == "__main__":
    main()
