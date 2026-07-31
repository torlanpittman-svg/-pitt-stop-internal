"""
Pull audit history for every Sterling dealer invoice using direct txnId navigation.

Known anchor: Invoice 100802 → txnId 23143, Invoice 100803 → txnId 23144
Offset formula: txnId ≈ invoice_number - 77659

For each invoice: estimate txnId, navigate to /app/audithistory?txnId=X,
verify the invoice number matches (try ±5 if not), then parse version history.
"""
import os, json, re, time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "audit_histories_v2_report.json")
LOG     = "/tmp/audit_hist.log"

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

# Known txnId anchors
KNOWN_TXNIDS = {
    "100802": 23143,
    "100803": 23144,
}
# Derived offset: invoice_number - txnId = 77659
TXN_OFFSET = 77659

# All dealer invoices to investigate
DEALER_INVOICES = [
    # num,   customer,                date,        amount,   status
    ("100711", "Sterling Subaru",    "5/13/26",  1200.00,  "Paid"),
    ("100712", "Sterling Kia",       "5/14/26",  1400.00,  "Paid"),
    ("100714", "Sterling Subaru",    "5/20/26",  1400.00,  "Paid"),
    ("100716", "Sterling Auto Group","5/21/26",  1200.00,  "Paid"),
    ("100720", "Sterling Auto Group","5/28/26",   725.00,  "Paid"),
    ("100721", "Sterling Subaru",    "5/28/26",   600.00,  "Paid"),
    ("100725", "Sterling Kia",       "5/29/26",   200.00,  "Paid"),
    ("100729", "Sterling Auto Group","5/29/26",  1600.00,  "Paid"),
    ("100739", "Sterling Subaru",    "?",            0,    "?"),
    ("100758", "Sterling Subaru",    "?",            0,    "?"),
    ("100771", "?",                  "?",            0,    "?"),
    ("100773", "?",                  "?",            0,    "?"),
    ("100775", "Sterling Subaru",    "~7/1/26",   200.00,  "?"),
    ("100777", "?",                  "?",            0,    "?"),
    ("100799", "Sterling Kia",       "7/21/26",  1325.00,  "Overdue"),
    ("100802", "Sterling Subaru",    "7/22/26",      0,    "Overdue"),  # known overwrite
    ("100803", "Sterling Subaru",    "7/22/26",   400.00,  "Overdue"),  # known overwrite
    ("100804", "?",                  "?",            0,    "?"),
]

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


def estimate_txn_id(inv_num):
    """Return estimated txnId using known offset."""
    return int(inv_num) - TXN_OFFSET


def get_audit_history_page(page, txn_id):
    """Fetch /app/audithistory?txnId=X and return body text."""
    url = f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}"
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    for _ in range(20):
        t = safe_text(page)
        if "Added by" in t or "Edited by" in t or len(t) > 4000:
            break
        page.wait_for_timeout(2000)
    return safe_text(page)


def find_txn_id(page, inv_num):
    """
    Find the correct txnId for an invoice by:
    1. Using known anchors
    2. Estimating from offset and verifying
    3. Searching ±10 around estimate
    """
    if inv_num in KNOWN_TXNIDS:
        logmsg(f"  Using known txnId: {KNOWN_TXNIDS[inv_num]}")
        return KNOWN_TXNIDS[inv_num]

    est = estimate_txn_id(inv_num)
    logmsg(f"  Estimated txnId: {est} (offset formula)")

    # Try estimated ±10
    for delta in [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9, -9, 10, -10]:
        candidate = est + delta
        try:
            text = get_audit_history_page(page, candidate)
            # Verify this is the right invoice — look for the invoice number
            if f"Invoice No. {inv_num}" in text or f"#{inv_num}" in text or f"No. {inv_num}" in text:
                logmsg(f"  Found at txnId={candidate} (delta={delta})")
                return candidate
            # Also check if this is even an invoice (not a payment/bill)
            if "Invoice" in text[:500] and ("Added by" in text or "Edited by" in text):
                # Extract invoice number from the page
                inv_match = re.search(r'Invoice No\.\s*(\d+)', text)
                if inv_match and inv_match.group(1) == inv_num:
                    logmsg(f"  Found at txnId={candidate} via No. match (delta={delta})")
                    return candidate
        except Exception as e:
            logmsg(f"  txnId={candidate} error: {e}")
            continue

    # If still not found, try using the invoice list with search
    logmsg(f"  Trying invoice list search for {inv_num}...")
    try:
        page.goto("https://qbo.intuit.com/app/invoices",
                  wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3000)

        # Try the search input at the top of the invoice list
        search_inputs = page.locator(
            "input[placeholder*='Search'], input[placeholder*='Find'], "
            "input[aria-label*='Search'], input[type='search']"
        )
        if search_inputs.count() > 0:
            search_inputs.first.fill(inv_num)
            page.wait_for_timeout(3000)

        # Look for the invoice number in the page
        text = safe_text(page)
        if inv_num in text:
            # Try clicking on it
            clicked = page.evaluate(f"""() => {{
                const all = Array.from(document.querySelectorAll('*'));
                const el = all.find(e => e.children.length === 0 && e.textContent.trim() === '{inv_num}');
                if (!el) return false;
                const row = el.closest('tr') || el.closest('[class*="row"]') || el.parentElement?.parentElement;
                if (!row) return false;
                const link = row.querySelector('a') || row;
                link.click();
                return true;
            }}""")
            if clicked:
                page.wait_for_timeout(4000)
                url = page.url
                m = re.search(r'txnId=(\d+)', url)
                if m:
                    logmsg(f"  Found via list click: txnId={m.group(1)}")
                    return int(m.group(1))
    except Exception as e:
        logmsg(f"  List search error: {e}")

    logmsg(f"  Could not find txnId for {inv_num}")
    return None


def parse_history(history_text, inv_num="?"):
    """
    Extract version snapshots from QBO audit history.
    Returns (list_of_versions, verdict).
    """
    versions = []

    snap_re = re.compile(
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+'
        r'\d{1,2}:\d{2}\s+(?:am|pm)[^:]+):\s+(.+)',
        re.MULTILINE
    )
    for m in snap_re.finditer(history_text):
        ts   = m.group(1).strip()
        desc = m.group(2).strip()
        actor_m = re.search(r'by\s+(.+)', desc)
        actor  = actor_m.group(1).strip() if actor_m else desc
        action = desc.split(" by ")[0].strip()

        start  = m.end()
        next_m = snap_re.search(history_text, start)
        block  = history_text[start: next_m.start() if next_m else start + 6000]

        name_m = re.search(r'\nName:\s*\n(.*?)(?:\n|$)', block)
        amt_m  = re.search(r'\nAmount:\s*\n([\d,.\s]+)', block)
        name_raw = name_m.group(1).strip() if name_m else ""
        amt_raw  = amt_m.group(1).strip().split()[0] if amt_m else ""
        name_lines = [l.strip() for l in name_raw.split("\n") if l.strip()]
        name_final = name_lines[-1] if name_lines else ""

        versions.append({
            "timestamp": ts,
            "action":    action,
            "actor":     actor,
            "customer":  name_final,
            "amount":    amt_raw,
        })

    ps_vs = [v for v in versions if "Pittstop" in v["actor"]]
    al_vs = [v for v in versions if "AutoLeap" in v["actor"]]

    verdict = "clean"
    if ps_vs and al_vs:
        orig_cust = ps_vs[-1]["customer"]
        al_cust   = al_vs[0]["customer"]
        if orig_cust and al_cust and orig_cust != al_cust:
            verdict = "OVERWRITTEN"
        else:
            verdict = "autoleap_touched"
    elif al_vs and not ps_vs:
        verdict = "autoleap_only"

    return versions, verdict


def fetch_audit_log_page1(page):
    """Grab page 1 of the audit log for event enumeration."""
    logmsg("\n── Audit log: page 1 ──")
    page.goto("https://qbo.intuit.com/app/auditlog",
              wait_until="domcontentloaded", timeout=60000)
    try:
        page.locator("button:has-text('×'), [aria-label='Close']").first.click(timeout=2000)
    except: pass
    page.wait_for_timeout(5000)

    text = safe_text(page)
    total_m = re.search(r'(\d+)\s*-\s*(\d+)\s+of\s+([\d,]+)', text)
    total = int(total_m.group(3).replace(",","")) if total_m else 0
    logmsg(f"  {total} total entries")
    ss(page, "auditlog_p01_v2")

    # Try to get additional pages using the Next button with JS force-click
    pages_text = [text]
    for pg in range(2, 10):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1000)

            # Try force-clicking Next via JS (bypasses overlay intercept)
            clicked = page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button, [role=button], a'));
                const nxt = btns.find(b => {
                    const t = (b.textContent || '').trim();
                    const a = (b.getAttribute('aria-label') || '').toLowerCase();
                    return t === '›' || t === 'Next' || a.includes('next') || a.includes('next page');
                });
                if (!nxt) return false;
                nxt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
                return true;
            }""")

            if not clicked:
                logmsg(f"  No Next button found at page {pg-1} — trying scroll pagination")
                # Try URL approach
                page.goto(f"https://qbo.intuit.com/app/auditlog?startPosition={(pg-1)*50}",
                          wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3000)

            else:
                page.wait_for_timeout(4000)

            pg_text = safe_text(page)
            if pg_text == pages_text[-1]:
                logmsg(f"  Page {pg}: unchanged — stopping")
                break

            pages_text.append(pg_text)
            logmsg(f"  Page {pg}: {len(pg_text)} chars")
            ss(page, f"auditlog_p{pg:02d}_v2")

        except Exception as e:
            logmsg(f"  Page {pg} error: {e}")
            break

    logmsg(f"  Captured {len(pages_text)} audit log pages")
    return "\n".join(pages_text)


def extract_audit_events(combined_text):
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


def main():
    logmsg("\nAudit history investigation v2 — direct txnId navigation")

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
        logmsg(f"  QBO: {p.url}")

        report = {
            "overwrites":   [],
            "al_touched":   [],
            "autoleap_only": [],
            "clean":        [],
            "not_found":    [],
            "audit_events": [],
        }

        # ── Step 1: Audit log ─────────────────────────────────────────────────
        combined_audit = fetch_audit_log_page1(p)
        audit_events   = extract_audit_events(combined_audit)
        logmsg(f"  Invoice audit events found: {len(audit_events)}")

        al_edits   = [e for e in audit_events if "AutoLeap" in e.get("user","")]
        ps_creates = [e for e in audit_events if "Pittstop" in e.get("user","") and "Created" in e.get("event","")]
        logmsg(f"  AutoLeap edits: {len(al_edits)}")
        logmsg(f"  Pittstop creates: {len(ps_creates)}")

        report["audit_events"] = audit_events

        # ── Step 2: Audit history for each dealer invoice ─────────────────────
        logmsg(f"\n── Processing {len(DEALER_INVOICES)} invoices ──")

        for inv_num, expected_cust, date, amount, status in DEALER_INVOICES:
            logmsg(f"\n── Invoice {inv_num} ({expected_cust}, {date}, ${amount}) ──")

            txn_id = find_txn_id(p, inv_num)
            if not txn_id:
                logmsg(f"  SKIPPED — could not find txnId")
                report["not_found"].append({"invoice_num": inv_num, "expected_customer": expected_cust})
                continue

            logmsg(f"  txnId: {txn_id}")
            history = get_audit_history_page(p, txn_id)
            ss(p, f"hist_v2_{inv_num}")

            versions, verdict = parse_history(history, inv_num)
            logmsg(f"  Versions: {len(versions)}, Verdict: {verdict}")

            for v in versions[:8]:  # show up to 8 versions
                logmsg(f"    {v['timestamp'][:25]} | {v['actor'][:20]} | {v['action']} "
                       f"| cust={v['customer'][:30]} | amt={v['amount']}")

            ps_vs = [v for v in versions if "Pittstop" in v["actor"]]
            al_vs = [v for v in versions if "AutoLeap" in v["actor"]]
            orig_cust = ps_vs[-1]["customer"] if ps_vs else ""
            orig_amt  = ps_vs[-1]["amount"]   if ps_vs else ""
            orig_ts   = ps_vs[-1]["timestamp"] if ps_vs else ""
            al_cust   = al_vs[0]["customer"]  if al_vs else ""
            al_amt    = al_vs[0]["amount"]    if al_vs else ""
            al_ts     = al_vs[0]["timestamp"] if al_vs else ""

            entry = {
                "invoice_num":        inv_num,
                "txn_id":             txn_id,
                "expected_customer":  expected_cust,
                "verdict":            verdict,
                "original_customer":  orig_cust,
                "original_amount":    orig_amt,
                "original_timestamp": orig_ts,
                "autoleap_customer":  al_cust,
                "autoleap_amount":    al_amt,
                "autoleap_timestamp": al_ts,
                "versions":           versions,
                "raw_history_excerpt": history[:3000],
            }

            if verdict == "OVERWRITTEN":
                report["overwrites"].append(entry)
                logmsg(f"  *** OVERWRITE CONFIRMED ***")
                logmsg(f"      Original: {orig_cust} ${orig_amt} ({orig_ts})")
                logmsg(f"      Replaced: {al_cust} ${al_amt} ({al_ts})")
            elif verdict == "autoleap_touched":
                report["al_touched"].append(entry)
                logmsg(f"  AutoLeap touched (no customer change detected)")
            elif verdict == "autoleap_only":
                report["autoleap_only"].append(entry)
                logmsg(f"  AutoLeap created this invoice (no Pittstop version)")
            else:
                report["clean"].append(entry)
                logmsg(f"  Clean — no AutoLeap involvement")

        # ── Final summary ──────────────────────────────────────────────────────
        logmsg("\n" + "="*60)
        logmsg("FINAL REPORT")
        logmsg("="*60)
        logmsg(f"\nCONFIRMED OVERWRITES ({len(report['overwrites'])}):")
        for o in report["overwrites"]:
            logmsg(f"  #{o['invoice_num']} (txnId {o['txn_id']}): "
                   f"{o['original_customer']} ${o['original_amount']} "
                   f"→ {o['autoleap_customer']} ${o['autoleap_amount']}")

        logmsg(f"\nAUTOLEAP TOUCHED — no customer change ({len(report['al_touched'])}):")
        for t in report["al_touched"]:
            logmsg(f"  #{t['invoice_num']} (txnId {t['txn_id']}): {t['expected_customer']}")

        logmsg(f"\nAUTOLEAP CREATED ({len(report['autoleap_only'])}):")
        for t in report["autoleap_only"]:
            logmsg(f"  #{t['invoice_num']} (txnId {t['txn_id']}): {t['autoleap_customer']}")

        logmsg(f"\nCLEAN ({len(report['clean'])}):")
        for c in report["clean"]:
            logmsg(f"  #{c['invoice_num']}")

        logmsg(f"\nNOT FOUND ({len(report['not_found'])}):")
        for n in report["not_found"]:
            logmsg(f"  #{n['invoice_num']} ({n['expected_customer']})")

        with open(OUT, "w") as f:
            json.dump(report, f, indent=2, default=str)
        logmsg(f"\nReport → {OUT}")
        logmsg("REPORT COMPLETE")

        logmsg(f"\nSignal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()


if __name__ == "__main__":
    main()
