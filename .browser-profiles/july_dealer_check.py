"""
July 2026 dealership invoice audit — read-only.

Checks only invoices in the July 2026 range that could be dealership invoices
touched by AutoLeap. Uses direct txnId navigation via known offset.

Known anchor: Invoice 100802 → txnId 23143, Invoice 100803 → txnId 23144
Offset: invoice_number - 77659 = txnId (approximately)

SAFETY: Read-only. No creates, edits, voids, or deletes.
"""
import os, json, re, time
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "july_dealer_report.json")
LOG     = "/tmp/audit_hist.log"

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

# Known txnIds
KNOWN_TXNIDS = {"100802": 23143, "100803": 23144}
TXN_OFFSET   = 77659  # invoice_number - txnId

# July 2026 invoices to check.
# Includes invoices AutoLeap edited in the audit log (from prior sweep)
# plus known dealership invoices in July range.
# Excludes 100806 (created by us as replacement — not an overwrite victim).
JULY_TARGETS = [
    # inv_num,  known_customer (or None if unknown)
    ("100771", None),              # AutoLeap edited — unknown customer
    ("100773", None),              # AutoLeap edited — unknown customer
    ("100775", "Sterling Subaru"), # AutoLeap edited Jul 1
    ("100777", None),              # AutoLeap edited — unknown customer
    ("100799", "Sterling Kia"),    # Overdue, user confirmed Sterling Kia affected
    ("100802", "Sterling Subaru"), # KNOWN overwrite, txnId 23143
    ("100803", "Sterling Subaru"), # KNOWN overwrite, txnId 23144 → replaced by 100806
    ("100804", None),              # AutoLeap edited — unknown customer
]

DEALER_KEYWORDS = {"sterling", "dealer", "auto group", "kia", "subaru", "hyundai",
                   "toyota", "honda", "ford", "chevrolet", "chevy", "nissan"}

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

def is_dealer(customer_name):
    if not customer_name: return False
    return any(k in customer_name.lower() for k in DEALER_KEYWORDS)

def get_audit_history(page, txn_id):
    """Navigate to /app/audithistory?txnId=X and return body text."""
    page.goto(f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}",
              wait_until="domcontentloaded", timeout=45000)
    for _ in range(20):
        t = safe_text(page)
        if "Added by" in t or "Edited by" in t or len(t) > 4000:
            break
        page.wait_for_timeout(2000)
    return safe_text(page)

def find_txn_id(page, inv_num):
    """Find txnId by known anchor or offset estimate, verified by checking the page."""
    if inv_num in KNOWN_TXNIDS:
        logmsg(f"  txnId {KNOWN_TXNIDS[inv_num]} (known)")
        return KNOWN_TXNIDS[inv_num]

    est = int(inv_num) - TXN_OFFSET
    logmsg(f"  Estimated txnId: {est}")

    for delta in [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9, -9, 10, -10]:
        cand = est + delta
        try:
            text = get_audit_history(page, cand)
            if (f"No. {inv_num}" in text or f"#{inv_num}" in text or
                    f"Invoice No. {inv_num}" in text):
                logmsg(f"  Confirmed txnId={cand} (delta={delta})")
                return cand
        except Exception as e:
            logmsg(f"  txnId={cand} error: {e}")
            continue

    logmsg(f"  Could not confirm txnId for {inv_num}")
    return est  # return estimate anyway so we still capture the history

def parse_history(text):
    """
    Extract version snapshots from audit history text.
    Returns (versions_list, verdict).
    verdict: OVERWRITTEN | autoleap_touched | autoleap_only | clean | unknown
    """
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
        actor  = actor_m.group(1).strip() if actor_m else desc
        action = desc.split(" by ")[0].strip()

        start  = m.end()
        nxt    = snap_re.search(text, start)
        block  = text[start: nxt.start() if nxt else start + 6000]

        name_m  = re.search(r'\nName:\s*\n(.*?)(?:\n|$)', block)
        amt_m   = re.search(r'\nAmount:\s*\n([\d,.\s]+)', block)
        date_m  = re.search(r'\nInvoice date:\s*\n([^\n]+)', block)
        name_raw = name_m.group(1).strip() if name_m else ""
        name_lines = [l.strip() for l in name_raw.split("\n") if l.strip()]
        name_final = name_lines[-1] if name_lines else ""
        amt_raw  = amt_m.group(1).strip().split()[0] if amt_m else ""
        date_raw = date_m.group(1).strip() if date_m else ""

        versions.append({
            "timestamp": ts,
            "action":    action,
            "actor":     actor,
            "customer":  name_final,
            "amount":    amt_raw,
            "date":      date_raw,
        })

    ps_vs  = [v for v in versions if "Pittstop" in v["actor"]]
    al_vs  = [v for v in versions if "AutoLeap" in v["actor"]]

    if not versions:
        verdict = "unknown"
    elif ps_vs and al_vs:
        orig = ps_vs[-1]["customer"]
        new  = al_vs[0]["customer"]
        if orig and new and orig.lower() != new.lower():
            verdict = "OVERWRITTEN"
        else:
            verdict = "autoleap_touched"
    elif al_vs and not ps_vs:
        verdict = "autoleap_only"
    elif ps_vs and not al_vs:
        verdict = "clean"
    else:
        verdict = "unknown"

    return versions, verdict


def main():
    logmsg("\nJuly 2026 dealer invoice audit — read-only")
    logmsg(f"Targets: {[t[0] for t in JULY_TARGETS]}\n")

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

        report = {"overwrites": [], "al_touched": [], "clean": [], "skipped": []}

        for inv_num, known_cust in JULY_TARGETS:
            logmsg(f"── Invoice {inv_num} ──")
            txn_id = find_txn_id(p, inv_num)

            history = get_audit_history(p, txn_id)
            ss(p, f"july_{inv_num}")
            versions, verdict = parse_history(history)

            # Pull key version data
            ps_vs  = [v for v in versions if "Pittstop" in v["actor"]]
            al_vs  = [v for v in versions if "AutoLeap" in v["actor"]]
            orig   = ps_vs[-1] if ps_vs else {}
            latest_al = al_vs[0] if al_vs else {}

            orig_cust  = orig.get("customer", "") or known_cust or ""
            orig_amt   = orig.get("amount", "")
            orig_date  = orig.get("date", "")
            orig_ts    = orig.get("timestamp", "")
            al_cust    = latest_al.get("customer", "")
            al_amt     = latest_al.get("amount", "")
            al_ts      = latest_al.get("timestamp", "")

            # If no Pittstop version, check whether AutoLeap's version is a dealer
            final_cust = orig_cust or al_cust
            dealer     = is_dealer(final_cust) or (known_cust is not None)

            logmsg(f"  Verdict: {verdict}  |  Dealer: {dealer}")
            logmsg(f"  Versions ({len(versions)}): " +
                   ", ".join(f"{v['actor'][:12]}@{v['timestamp'][:16]}" for v in versions[:5]))
            if orig_cust:  logmsg(f"  Original: {orig_cust} ${orig_amt} ({orig_date})")
            if al_cust:    logmsg(f"  AutoLeap: {al_cust} ${al_amt} ({al_ts})")

            entry = {
                "invoice_num":       inv_num,
                "txn_id":            txn_id,
                "verdict":           verdict,
                "is_dealer":         dealer,
                "known_customer":    known_cust,
                "original_customer": orig_cust,
                "original_amount":   orig_amt,
                "original_date":     orig_date,
                "original_created":  orig_ts,
                "autoleap_customer": al_cust,
                "autoleap_amount":   al_amt,
                "autoleap_ts":       al_ts,
                "versions":          versions,
                "raw_excerpt":       history[:4000],
            }

            if verdict == "OVERWRITTEN":
                report["overwrites"].append(entry)
                logmsg(f"  *** OVERWRITE: {orig_cust} → {al_cust} ***")
            elif verdict in ("autoleap_touched", "autoleap_only"):
                report["al_touched"].append(entry)
            else:
                report["clean"].append(entry)

            logmsg("")

        # Summary
        logmsg("=" * 60)
        logmsg("JULY 2026 DEALER INVOICE REPORT")
        logmsg("=" * 60)

        logmsg(f"\nCONFIRMED OVERWRITES ({len(report['overwrites'])}):")
        for o in report["overwrites"]:
            logmsg(f"  #{o['invoice_num']} | {o['original_customer']} | "
                   f"${o['original_amount']} | {o['original_date']} "
                   f"→ replaced by AutoLeap ({o['autoleap_customer']})")

        logmsg(f"\nAUTOLEAP TOUCHED (may need manual review) ({len(report['al_touched'])}):")
        for t in report["al_touched"]:
            logmsg(f"  #{t['invoice_num']} | {t['original_customer'] or t['autoleap_customer']} "
                   f"| verdict={t['verdict']}")

        logmsg(f"\nCLEAN ({len(report['clean'])}):")
        for c in report["clean"]:
            logmsg(f"  #{c['invoice_num']}")

        with open(OUT, "w") as f:
            json.dump(report, f, indent=2, default=str)
        logmsg(f"\nReport → {OUT}")
        logmsg("REPORT COMPLETE")

        logmsg(f"\nSignal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()


if __name__ == "__main__":
    main()
