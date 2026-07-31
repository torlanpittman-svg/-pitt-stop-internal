"""
Targeted scan: find the Sterling Kia invoice that was created before
the Jul 17 $800 payment and may have been overwritten by AutoLeap on
Jul 20 morning (~7:20-7:34 am).

Scans txnId 23062–23112 with adequate page wait time (5s) to let QBO
Angular components render before reading page text.

SAFETY: Read-only. No creates, edits, voids, or deletes.
"""
import os, json, re, time
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "sterling_kia_scan.json")
LOG     = "/tmp/audit_hist.log"

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

STERLING_KIA = ["sterling kia", "sterling  kia"]  # double-space in case of tab-separated

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

def is_sterling_kia(text):
    t = text.lower()
    return "sterling kia" in t

def has_atlas(text):
    t = text.lower()
    return any(k in t for k in ["atlas", "volkswagen", "vw atlas"])

def parse_basic_versions(text):
    """Extract timestamp / actor / action lines from audit history."""
    versions = []
    pat = re.compile(
        r'((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+'
        r'\d{1,2}:\d{2}\s+(?:am|pm)[^:]+):\s+(.+)',
        re.MULTILINE
    )
    for m in pat.finditer(text):
        ts   = m.group(1).strip()
        desc = m.group(2).strip()
        actor_m = re.search(r'by\s+(.+)', desc)
        actor   = actor_m.group(1).strip() if actor_m else desc
        action  = desc.split(" by ")[0].strip()
        start   = m.end()
        nxt     = pat.search(text, start)
        block   = text[start: nxt.start() if nxt else start + 3000]

        name_m  = re.search(r'\nName:\s*\n(.*?)(?:\n|$)', block)
        amt_m   = re.search(r'\nAmount:\s*\n([\d,.\s]+)', block)
        name_raw = name_m.group(1).strip() if name_m else ""

        # Extract line items for extra context
        items = re.findall(r'\t([A-Za-z][^\t]{3,60})\t.*?\t([\d,]+\.?\d*)\t', block)

        versions.append({
            "timestamp": ts,
            "action": action,
            "actor": actor,
            "customer": name_raw.split("\n")[-1].strip(),
            "amount": (amt_m.group(1).strip().split()[0] if amt_m else ""),
            "has_atlas": has_atlas(block),
            "is_sterling_kia": is_sterling_kia(block),
            "line_items_sample": items[:6],
            "raw_block": block[:800],
        })
    return versions


def scan_range(page, start, end):
    hits = []
    logmsg(f"\nScanning txnId {start}–{end}...")
    logmsg(f"{'TxnID':<8} {'Type/Header':<30} {'SterlingKia':<13} {'Atlas':<8} {'AutoLeap':<10} {'Deleted'}")

    for txn_id in range(start, end + 1):
        try:
            page.goto(
                f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}",
                wait_until="domcontentloaded", timeout=20000
            )
            # Give Angular time to render — critical
            page.wait_for_timeout(5000)
            text = safe_text(page)

            if not text or len(text) < 300:
                logmsg(f"{txn_id:<8} [no content / load error]")
                continue

            # Determine transaction type from header
            hdr_m = re.search(
                r'History of this transaction:\s*([\w\s]+(?:No\.\s*\d+)?)', text
            )
            hdr = hdr_m.group(1).strip() if hdr_m else "?"

            sk     = is_sterling_kia(text)
            atlas  = has_atlas(text)
            al     = "AutoLeap" in text
            deleted= "Deleted" in text

            logmsg(f"{txn_id:<8} {hdr[:30]:<30} {str(sk):<13} {str(atlas):<8} {str(al):<10} {deleted}")

            if sk or atlas:
                ss(page, f"sk_scan_{txn_id}")
                versions = parse_basic_versions(text)
                hits.append({
                    "txn_id": txn_id,
                    "header": hdr,
                    "is_sterling_kia": sk,
                    "has_atlas": atlas,
                    "autoleap": al,
                    "deleted": deleted,
                    "text_length": len(text),
                    "versions": versions,
                    "raw_excerpt": text[:4000],
                })
                logmsg(f"  *** HIT txnId={txn_id}: SK={sk}, Atlas={atlas}, AL={al}, Del={deleted}")
                for v in versions[:8]:
                    logmsg(f"      {v['timestamp'][:26]} | {v['actor'][:25]} | {v['action']}"
                           f" | cust={v['customer'][:30]} | ${v['amount']}"
                           f" | atlas={v['has_atlas']} | sk={v['is_sterling_kia']}")

        except Exception as e:
            logmsg(f"{txn_id:<8} [error: {str(e)[:60]}]")
            continue

    logmsg(f"\nScan complete: {len(hits)} Sterling Kia / Atlas hits in {start}-{end}")
    return hits


def main():
    logmsg("\n" + "="*70)
    logmsg("SCAN: Sterling Kia invoice in txnId 23062–23112")
    logmsg("Purpose: find the invoice the $800 payment (txnId 23112) was")
    logmsg("applied to — may have been overwritten by AutoLeap Jul 20 ~7:20am")
    logmsg("="*70)

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
        logmsg(f"QBO: {p.url}\n")

        # Primary scan: the 50 txnIds before the payment
        hits = scan_range(p, 23062, 23112)

        # If nothing found, also check slightly broader range
        if not hits:
            logmsg("\nNo hits in 23062-23112. Checking 23040-23061...")
            hits += scan_range(p, 23040, 23061)

        report = {
            "scan_range": "23062-23112 (+23040-23061 if no hits)",
            "purpose": "Find Sterling Kia invoice before Jul 17 $800 payment",
            "hits": hits,
            "conclusion": "",
        }

        if hits:
            sk_hits = [h for h in hits if h["is_sterling_kia"]]
            al_hits = [h for h in hits if h["is_sterling_kia"] and h["autoleap"]]
            if al_hits:
                c = al_hits[0]
                versions = c["versions"]
                ps_v = [v for v in versions if "Pittstop" in v["actor"]]
                al_v = [v for v in versions if "AutoLeap" in v["actor"]]
                report["conclusion"] = (
                    f"CONFIRMED OVERWRITE: Sterling Kia invoice at txnId={c['txn_id']} "
                    f"overwritten by AutoLeap. "
                    f"Pittstop versions: {len(ps_v)}, AutoLeap versions: {len(al_v)}"
                )
                logmsg(f"\n{'='*60}")
                logmsg(f"CONCLUSION: {report['conclusion']}")
            elif sk_hits:
                c = sk_hits[0]
                report["conclusion"] = (
                    f"Sterling Kia invoice found at txnId={c['txn_id']} "
                    f"— no AutoLeap involvement detected"
                )
                logmsg(f"\nCONCLUSION: {report['conclusion']}")
            else:
                report["conclusion"] = "No Sterling Kia invoice found in range — may be outside scan window"
                logmsg(f"\nCONCLUSION: {report['conclusion']}")
        else:
            report["conclusion"] = "No Sterling Kia or Atlas hits in any scanned range"
            logmsg(f"\nCONCLUSION: {report['conclusion']}")

        with open(OUT, "w") as f:
            json.dump(report, f, indent=2, default=str)
        logmsg(f"\nReport → {OUT}")
        logmsg("SCAN COMPLETE")

        logmsg(f"\nSignal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()


if __name__ == "__main__":
    main()
