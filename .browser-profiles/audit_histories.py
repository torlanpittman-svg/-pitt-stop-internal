"""
Pull audit history for every Sterling dealer invoice found in QBO.
Opens each invoice by clicking View/Edit in the invoice list to get the txnId,
then pulls /app/audithistory?txnId=X and scans for AutoLeap overwrites.
Also paginates the full audit log (all 418 entries across 9 pages).
"""
import os, json, re, time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "audit_histories_report.json")

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

# All Sterling dealer invoice numbers visible in the invoice list
# (from previous run — confirmed present in QBO)
DEALER_INVOICES = [
    # num,  customer,               date,       amount,   status
    ("100799", "Sterling Kia",       "7/21/26",  1325.00,  "Overdue"),
    ("100806", "Sterling Subaru",    "7/22/26",   400.00,  "Overdue"),   # just created — skip history
    ("100775", "Sterling Subaru",    "~7/1/26",   200.00,  "?"),         # AutoLeap edited Jul 1
    ("100758", "Sterling Subaru",    "?",            0,    "?"),
    ("100739", "Sterling Subaru",    "?",            0,    "?"),
    ("100721", "Sterling Subaru",    "5/28/26",   600.00,  "Paid"),
    ("100720", "Sterling Auto Group","5/28/26",   725.00,  "Paid"),
    ("100716", "Sterling Auto Group","5/21/26",  1200.00,  "Paid"),
    ("100714", "Sterling Subaru",    "5/20/26",  1400.00,  "Paid"),
    ("100712", "Sterling Kia",       "5/14/26",  1400.00,  "Paid"),
    ("100711", "Sterling Subaru",    "5/13/26",  1200.00,  "Paid"),
    ("100729", "Sterling Auto Group","5/29/26",  1600.00,  "Paid"),
    ("100725", "Sterling Kia",       "5/29/26",   200.00,  "Paid"),
]

# Also check every invoice AutoLeap edited in the audit log
AUTOLEAP_EDITS = ["100775", "100771", "100773", "100777",  # from audit log sweep
                  "100802", "100803", "100804"]             # known from earlier

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


def get_txn_id_by_clicking(page, invoice_num):
    """Navigate to invoice list, click View/Edit on the target invoice, return txnId."""
    page.goto("https://qbo.intuit.com/app/invoices",
              wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(3000)

    # Use JS to find the row and click View/Edit
    clicked = page.evaluate(f"""() => {{
        const cells = Array.from(document.querySelectorAll('td'));
        const target = cells.find(c => c.textContent.trim() === '{invoice_num}');
        if (!target) return false;
        const row = target.closest('tr');
        if (!row) return false;
        // Find View/Edit link — it may be an anchor or span
        const links = Array.from(row.querySelectorAll('a, button, [role=button]'));
        const viewLink = links.find(l =>
            (l.textContent||'').trim().toLowerCase().includes('view') ||
            (l.getAttribute('aria-label')||'').toLowerCase().includes('view')
        );
        if (viewLink) {{ viewLink.click(); return true; }}
        // Try clicking the invoice number cell itself
        target.click();
        return true;
    }}""")

    if not clicked:
        log(f"  Row for {invoice_num} not found in current list page")
        return None

    page.wait_for_timeout(4000)
    url = page.url
    m = re.search(r'txnId=(\d+)', url)
    if m:
        return m.group(1)

    # Try to read txnId from page content
    text = safe_text(page)[:500]
    m2 = re.search(r'txnId[=:](\d+)', text)
    return m2.group(1) if m2 else None


def get_audit_history(page, txn_id):
    """Fetch and return the full audit history for a txnId."""
    page.goto(f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}",
              wait_until="domcontentloaded", timeout=45000)
    for _ in range(20):
        t = safe_text(page)
        if "Added by" in t or "Edited by" in t or len(t) > 4000: break
        page.wait_for_timeout(2000)
    return safe_text(page)


def parse_history(history_text, invoice_num="?"):
    """
    Extract version snapshots from QBO audit history.
    Returns list of {action, actor, customer, amount} and a verdict.
    """
    versions = []

    # Each snapshot starts with a timestamp line like:
    # "Jul 22, 3:52 pm Central Daylight Time: Added by Pittstop Detail"
    snap_re = re.compile(
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+'
        r'\d{1,2}:\d{2}\s+(?:am|pm)[^:]+):\s+(.+)',
        re.MULTILINE
    )
    for m in snap_re.finditer(history_text):
        ts   = m.group(1).strip()
        desc = m.group(2).strip()   # e.g. "Edited by AutoLeap System"
        actor_m = re.search(r'by\s+(.+)', desc)
        actor = actor_m.group(1).strip() if actor_m else desc
        action = desc.split(" by ")[0].strip()

        # Extract Name (customer) and Amount from the block after this marker
        start = m.end()
        # Find the next snapshot to bound the block
        next_m = snap_re.search(history_text, start)
        block = history_text[start: next_m.start() if next_m else start + 4000]

        name_m = re.search(r'\nName:\s*\n(.*?)(?:\n|$)', block)
        amt_m  = re.search(r'\nAmount:\s*\n([\d,.\s]+)', block)
        # When QBO shows both old and new values on the same field, they appear on separate lines
        name_raw = name_m.group(1).strip() if name_m else ""
        amt_raw  = amt_m.group(1).strip().split()[0] if amt_m else ""
        # Take the LAST line of name (new value if there are two lines = old \n new)
        name_lines = [l.strip() for l in name_raw.split("\n") if l.strip()]
        name_final = name_lines[-1] if name_lines else ""

        versions.append({
            "timestamp": ts,
            "action":    action,
            "actor":     actor,
            "customer":  name_final,
            "amount":    amt_raw,
        })

    # Determine verdict
    pittstop_vs = [v for v in versions if "Pittstop" in v["actor"]]
    autoleap_vs = [v for v in versions if "AutoLeap" in v["actor"]]

    verdict = "clean"
    if pittstop_vs and autoleap_vs:
        # Original (first Pittstop entry = oldest = last in list since QBO shows newest first)
        original_cust = pittstop_vs[-1]["customer"] if pittstop_vs else ""
        original_amt  = pittstop_vs[-1]["amount"]   if pittstop_vs else ""
        autoleap_cust = autoleap_vs[0]["customer"]  if autoleap_vs else ""
        autoleap_amt  = autoleap_vs[0]["amount"]    if autoleap_vs else ""

        if original_cust and autoleap_cust and original_cust != autoleap_cust:
            verdict = "OVERWRITTEN"
        elif autoleap_vs:
            verdict = "autoleap_touched"

    return versions, verdict


def fetch_all_audit_log(page):
    """Page through the entire audit log and return all raw entry text."""
    log("\n── Full audit log: all pages ──")
    page.goto("https://qbo.intuit.com/app/auditlog",
              wait_until="domcontentloaded", timeout=60000)
    try:
        page.locator("button:has-text('×'), [aria-label='Close']").first.click(timeout=2000)
    except: pass
    page.wait_for_timeout(5000)

    all_text = safe_text(page)
    total_m = re.search(r'(\d+)\s*-\s*(\d+)\s+of\s+([\d,]+)', all_text)
    total_items = int(total_m.group(3).replace(",","")) if total_m else 0
    total_pages = max(9, (total_items + 49) // 50)
    log(f"  {total_items} entries, {total_pages} pages")

    pages_text = [all_text]
    ss(page, "fullaudit_p01")

    for pg in range(2, total_pages + 1):
        try:
            # Scroll to bottom first to make pagination visible
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1000)

            nxt = page.locator(
                "button[aria-label='Go to next page'], "
                "button[aria-label='Next page'], "
                "button[title='Next page'], "
                "[data-testid='next-page-button'], "
                "button:has-text('›'), "
                "button:has-text('Next')"
            ).last
            if nxt.count() == 0:
                log(f"  No Next button at page {pg-1}")
                # Try URL-based pagination
                page.goto(f"https://qbo.intuit.com/app/auditlog?startPosition={(pg-1)*50}",
                          wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3000)
            else:
                if not nxt.is_enabled():
                    log(f"  Next button disabled at page {pg-1} — done")
                    break
                nxt.click()
                page.wait_for_timeout(4000)

            pg_text = safe_text(page)
            ss(page, f"fullaudit_p{pg:02d}")

            # Verify page changed (check timestamp in text)
            if pg_text == pages_text[-1]:
                log(f"  Page {pg}: no change — stopping")
                break

            pages_text.append(pg_text)
            log(f"  Page {pg}: ok ({len(pg_text)} chars)")
        except Exception as e:
            log(f"  Page {pg} error: {e}")
            break

    log(f"  Captured {len(pages_text)} pages")
    return "\n".join(pages_text)


def extract_audit_events(combined_text):
    """Extract all invoice-related audit events."""
    events = []
    pattern = re.compile(
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+'
        r'\d{1,2}:\d{2}\s+(?:am|pm)[^\n]+)\n\s*([^\n]+)\n\s*([^\n]+)',
        re.MULTILINE
    )
    for m in pattern.finditer(combined_text):
        ts    = m.group(1).strip()
        user  = m.group(2).strip()
        event = m.group(3).strip()
        if "Invoice" not in event: continue

        inv_m  = re.search(r'Invoice No\.\s*(\d+)', event)
        cust_m = re.search(r'No\.\s*\d+\s+for\s+(.+?)\s+for\s+\$', event)
        amt_m  = re.search(r'\$([\d,]+\.?\d*)', event)
        events.append({
            "ts": ts, "user": user, "event": event,
            "inv": inv_m.group(1) if inv_m else None,
            "cust": cust_m.group(1).strip() if cust_m else None,
            "amt": amt_m.group(1) if amt_m else None,
        })
    return events


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    log("Targeted audit history investigation")

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
            log("QBO session expired — please log in.")
            wait_for_ready()
            p.wait_for_timeout(3000)
        log(f"  QBO: {p.url}")

        report = {
            "overwrites":   [],
            "al_touched":   [],
            "clean":        [],
            "audit_events": [],
        }

        # ── Step 1: Full audit log ─────────────────────────────────────────────
        combined_audit = fetch_all_audit_log(p)
        audit_events   = extract_audit_events(combined_audit)
        log(f"\n  Total invoice audit events: {len(audit_events)}")

        # AutoLeap edits
        al_edits = [e for e in audit_events if "AutoLeap" in e["user"]]
        al_creates = [e for e in audit_events
                      if "AutoLeap" in e["user"] and "Created" in e["event"]]
        log(f"  AutoLeap edits:   {len(al_edits)}")
        log(f"  AutoLeap creates: {len(al_creates)}")

        # Pittstop Detail created invoices
        ps_creates = [e for e in audit_events
                      if "Pittstop" in e["user"] and "Created" in e["event"]]
        log(f"  Pittstop creates: {len(ps_creates)}")

        # Invoice numbers created by Pittstop Detail
        ps_inv_nums = {e["inv"] for e in ps_creates if e.get("inv")}
        log(f"  Pittstop-created invoice numbers: {sorted(ps_inv_nums)}")

        # Invoice numbers where AutoLeap edited a Pittstop-created invoice
        al_on_ps = {e["inv"] for e in al_edits if e.get("inv") in ps_inv_nums}
        log(f"  AutoLeap edited Pittstop-created invoices: {sorted(al_on_ps)}")

        report["audit_events"] = audit_events
        report["al_on_pittstop_invoices"] = list(al_on_ps)

        # ── Step 2: Get audit history for all dealer + suspicious invoices ──────
        # Combine dealer list + AutoLeap-edited + Pittstop-created that AutoLeap touched
        target_nums = set()
        for inv_num, *_ in DEALER_INVOICES:
            target_nums.add(inv_num)
        for n in AUTOLEAP_EDITS:
            target_nums.add(n)
        for n in al_on_ps:
            if n: target_nums.add(n)

        target_nums.discard("100806")  # just created by us, skip
        log(f"\n  Invoices to check: {sorted(target_nums)}")

        txn_cache = {}  # inv_num → txnId

        for inv_num in sorted(target_nums, key=lambda x: int(x) if x and x.isdigit() else 0):
            log(f"\n── Invoice {inv_num} ──")
            # Get txnId
            txn_id = get_txn_id_by_clicking(p, inv_num)
            if not txn_id:
                log(f"  Could not find txnId for {inv_num} — skipping")
                continue
            txn_cache[inv_num] = txn_id
            log(f"  txnId: {txn_id}")

            # Get audit history
            history = get_audit_history(p, txn_id)
            ss(p, f"hist_{inv_num}")
            versions, verdict = parse_history(history, inv_num)

            log(f"  Verdict: {verdict}")
            for v in versions:
                log(f"    {v['timestamp'][:22]} | {v['actor'][:25]} | "
                    f"{v['action']} | cust={v['customer']} | amt={v['amount']}")

            # Find original and final customers
            ps_vs = [v for v in versions if "Pittstop" in v["actor"]]
            al_vs = [v for v in versions if "AutoLeap" in v["actor"]]
            orig_cust = ps_vs[-1]["customer"] if ps_vs else ""
            orig_amt  = ps_vs[-1]["amount"]   if ps_vs else ""
            al_cust   = al_vs[0]["customer"]  if al_vs else ""
            al_amt    = al_vs[0]["amount"]    if al_vs else ""

            entry = {
                "invoice_num":   inv_num,
                "txn_id":        txn_id,
                "verdict":       verdict,
                "original_customer": orig_cust,
                "original_amount":   orig_amt,
                "autoleap_customer": al_cust,
                "autoleap_amount":   al_amt,
                "versions":      versions,
            }

            if verdict == "OVERWRITTEN":
                report["overwrites"].append(entry)
                log(f"  *** OVERWRITE: {orig_cust} (${orig_amt}) → {al_cust} (${al_amt}) ***")
            elif verdict == "autoleap_touched":
                report["al_touched"].append(entry)
            else:
                report["clean"].append(entry)

        # ── Final summary ──────────────────────────────────────────────────────
        log("\n" + "="*60)
        log("FINAL REPORT")
        log("="*60)
        log(f"\nCONFIRMED OVERWRITES ({len(report['overwrites'])}):")
        for o in report["overwrites"]:
            log(f"  #{o['invoice_num']} (txnId {o['txn_id']}): "
                f"{o['original_customer']} ${o['original_amount']} "
                f"→ {o['autoleap_customer']} ${o['autoleap_amount']}")

        log(f"\nAUTOLEAP TOUCHED — no customer change ({len(report['al_touched'])}):")
        for t in report["al_touched"]:
            log(f"  #{t['invoice_num']} (txnId {t['txn_id']}): "
                f"{t['original_customer']} — needs manual review")

        log(f"\nCLEAN ({len(report['clean'])} invoices verified unaffected)")

        with open(OUT, "w") as f:
            json.dump(report, f, indent=2, default=str)
        log(f"\nReport → {OUT}")

        log(f"\nSignal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()


if __name__ == "__main__":
    main()
