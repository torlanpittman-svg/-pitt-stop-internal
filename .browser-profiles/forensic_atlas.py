"""
Forensic read-only check: Sterling Kia / blue VW Atlas invoice.

Key lead: a Sterling Kia payment of $800 (txnId 23112) was created Jul 17
and deleted by Pittstop Detail on Jul 21 at 1:41 pm — three hours before
Invoice 100799 (Sterling Kia, $1,125 including VW Atlas Blue) was created at
4:41 pm the same day. This suggests Invoice 100799 may be a re-creation of
an earlier invoice that was overwritten.

Invoice 100771 was in the audit log AutoLeap-edit list but its actual txnId
was never confirmed. It may contain the VW Atlas work.

Strategy:
  1. Find Invoice 100771 via audit log / global search (same method that found
     100773 and 100775 reliably).
  2. Scan the txnId range 23100–23140 for any Sterling Kia invoice mentioning
     Atlas, Volkswagen, or VW.
  3. Search the QBO global search and invoice list for "Atlas" and "Volkswagen".
  4. Review the deleted payment (txnId 23112) to identify which invoice it was
     applied against.
  5. Scan the audit log for any deleted/overwritten invoice in Jul 17–21 range
     with Sterling Kia.

SAFETY: Read-only. No creates, edits, voids, or deletes.
"""
import os, json, re, time
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "forensic_atlas_report.json")
LOG     = "/tmp/audit_hist.log"

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

ATLAS_KEYWORDS = ["atlas", "volkswagen", "vw atlas"]
DEALER_KEYWORDS = {"sterling", "auto group", "kia", "subaru", "hyundai"}

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

def wait_for_content(page, keywords=None, min_len=4000, timeout=40):
    for _ in range(timeout // 2):
        t = safe_text(page)
        if (keywords and any(k in t for k in keywords)) or len(t) > min_len:
            return t
        page.wait_for_timeout(2000)
    return safe_text(page)

def has_atlas(text):
    t = text.lower()
    return any(k in t for k in ATLAS_KEYWORDS)

def is_dealer(text):
    t = text.lower()
    return any(k in t for k in DEALER_KEYWORDS)

def get_audit_history(page, txn_id, wait_secs=3):
    page.goto(f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}",
              wait_until="domcontentloaded", timeout=30000)
    return wait_for_content(page, ["Added by","Edited by","Deleted by","History of"])

def parse_versions(text):
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
        start   = m.end()
        nxt     = snap_re.search(text, start)
        block   = text[start: nxt.start() if nxt else start + 8000]
        name_m  = re.search(r'\nName:\s*\n(.*?)(?:\n|$)', block)
        amt_m   = re.search(r'\nAmount:\s*\n([\d,.\s]+)', block)
        name_raw = name_m.group(1).strip() if name_m else ""
        name_lines = [l.strip() for l in name_raw.split("\n") if l.strip()]
        versions.append({
            "timestamp": ts, "action": action, "actor": actor,
            "customer":  name_lines[-1] if name_lines else "",
            "amount":    (amt_m.group(1).strip().split()[0] if amt_m else ""),
            "has_atlas": has_atlas(block),
            "raw_block": block[:600],
        })
    return versions


# ── Probe 1: Find Invoice 100771 via audit log ─────────────────────────────────

def find_invoice_via_audit_log(page, inv_num):
    logmsg(f"  Searching audit log for invoice {inv_num}...")
    page.goto("https://qbo.intuit.com/app/auditlog",
              wait_until="domcontentloaded", timeout=60000)
    try:
        page.locator("button:has-text('×'), [aria-label='Close']").first.click(timeout=2000)
    except: pass
    page.wait_for_timeout(5000)

    for pg in range(1, 10):
        text = safe_text(page)
        if inv_num in text:
            logmsg(f"    Found '{inv_num}' on audit log page {pg}")
            ss(page, f"atlas_auditlog_p{pg:02d}_{inv_num}")
            # Click the View/History link in that row
            result = page.evaluate(f"""() => {{
                const rows = Array.from(document.querySelectorAll('tr, [class*=row]'));
                const row = rows.find(r => r.textContent.includes('{inv_num}'));
                if (!row) return null;
                const links = Array.from(row.querySelectorAll('a'));
                for (const l of links) {{
                    if (l.href && l.href.includes('txnId')) return l.href;
                }}
                const btns = Array.from(row.querySelectorAll('a, button, [role=button]'));
                const view = btns.find(b =>
                    (b.textContent || '').trim().toLowerCase().includes('view') ||
                    (b.textContent || '').trim().toLowerCase().includes('history')
                );
                if (view) {{ view.dispatchEvent(new MouseEvent('click', {{bubbles: true}})); return 'clicked'; }}
                return null;
            }}""")
            if result and 'txnId=' in str(result):
                m = re.search(r'txnId=(\d+)', str(result))
                if m: return int(m.group(1))
            if result == 'clicked':
                page.wait_for_timeout(4000)
                m = re.search(r'txnId=(\d+)', page.url)
                if m: return int(m.group(1))

        # next page
        advanced = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('button,[role=button],a'));
            const nxt = btns.find(b => {
                const t = (b.textContent || '').trim();
                const a = (b.getAttribute('aria-label') || '').toLowerCase();
                return t === '›' || t === 'Next' || a.includes('next');
            });
            if (!nxt) return false;
            nxt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
            return true;
        }""")
        if not advanced: break
        page.wait_for_timeout(4000)
    return None


def find_invoice_via_search(page, inv_num):
    logmsg(f"  Global search for invoice {inv_num}...")
    page.goto("https://qbo.intuit.com/app/homepage", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)
    try:
        search = page.locator(
            "input[placeholder*='Search'], input[placeholder*='Find'], "
            "input[aria-label*='Search'], input[type='search']"
        ).first
        search.fill(inv_num)
        page.wait_for_timeout(2000)
        page.keyboard.press("Enter")
        page.wait_for_timeout(3000)
        text = safe_text(page)
        if inv_num in text:
            clicked = page.evaluate(f"""() => {{
                const els = Array.from(document.querySelectorAll('a, [role=link]'));
                const el = els.find(e => e.textContent.includes('{inv_num}'));
                if (el) {{ el.click(); return true; }}
                return false;
            }}""")
            if clicked:
                page.wait_for_timeout(4000)
                m = re.search(r'txnId=(\d+)', page.url)
                if m: return int(m.group(1))
    except Exception as e:
        logmsg(f"    Search error: {e}")
    return None


# ── Probe 2: Scan txnId range for Atlas/Sterling Kia ─────────────────────────

def scan_range_for_atlas(page, start, end):
    logmsg(f"  Scanning txnId {start}–{end} for Atlas/VW/Sterling Kia...")
    hits = []
    for txn_id in range(start, end + 1):
        try:
            page.goto(f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}",
                      wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(1200)
            text = safe_text(page)
            if not text or len(text) < 200: continue

            # Determine transaction type header
            type_m  = re.search(r'History of this transaction:\s*([\w\s]+(?:No\.\s*\d+)?)', text)
            hdr = type_m.group(1).strip() if type_m else ""

            atlas   = has_atlas(text)
            dealer  = is_dealer(text)
            deleted = "Deleted" in text
            al_edit = "AutoLeap System" in text

            if atlas or (dealer and (deleted or al_edit)):
                logmsg(f"    txnId={txn_id}: {hdr} | atlas={atlas} | dealer={dealer} | deleted={deleted} | autoleap={al_edit}")
                ss(page, f"atlas_scan_{txn_id}")
                hits.append({
                    "txn_id": txn_id,
                    "header": hdr,
                    "has_atlas": atlas,
                    "is_dealer": dealer,
                    "deleted": deleted,
                    "autoleap": al_edit,
                    "text_excerpt": text[:2000],
                    "versions": parse_versions(text),
                })
        except Exception:
            continue
    logmsg(f"  Scan complete: {len(hits)} hits")
    return hits


# ── Probe 3: QBO search for "Atlas" / "Volkswagen" ───────────────────────────

def search_qbo_for_term(page, term):
    logmsg(f"  QBO global search: '{term}'")
    page.goto("https://qbo.intuit.com/app/homepage", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)
    results = []
    try:
        search = page.locator(
            "input[placeholder*='Search'], input[aria-label*='Search'], input[type='search']"
        ).first
        search.fill(term)
        page.wait_for_timeout(2000)
        page.keyboard.press("Enter")
        page.wait_for_timeout(3000)
        ss(page, f"atlas_search_{term.replace(' ','_')}")
        text = safe_text(page)
        logmsg(f"    Results length: {len(text)} chars")
        if term.lower() in text.lower():
            logmsg(f"    '{term}' found in search results")
            # Extract all links that look like invoices
            links = page.evaluate("""() => {
                return Array.from(document.querySelectorAll('a[href*="txnId"]'))
                    .map(l => l.href)
                    .filter((v,i,a) => a.indexOf(v) === i);
            }""")
            for href in links[:10]:
                m = re.search(r'txnId=(\d+)', href)
                if m: results.append({"txn_id": int(m.group(1)), "href": href})
            logmsg(f"    Invoice links found: {results}")
        else:
            logmsg(f"    '{term}' not in search results")
    except Exception as e:
        logmsg(f"    Search error: {e}")
    return results, safe_text(page)


# ── Probe 4: Inspect the deleted payment (txnId 23112) ───────────────────────

def inspect_deleted_payment(page):
    logmsg("\n  Inspecting deleted Sterling Kia payment (txnId 23112)...")
    text = get_audit_history(page, 23112)
    ss(page, "atlas_payment_23112")
    logmsg(f"  Payment 23112 text ({len(text)} chars):\n" + text[:1500])

    # Find which invoice(s) this payment was applied to
    inv_refs = re.findall(r'Invoice No\.\s*(\d+)', text)
    txn_refs = re.findall(r'txnId[=:](\d+)', text)
    amt_refs = re.findall(r'Amount:\s*\n([\d,\.]+)', text)
    logmsg(f"  Invoice refs in payment: {inv_refs}")
    logmsg(f"  txnId refs in payment:   {txn_refs}")
    logmsg(f"  Amounts in payment:      {amt_refs}")
    return text, inv_refs, txn_refs


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    logmsg("\nForensic atlas investigation — read-only")
    logmsg("Target: Sterling Kia / blue Volkswagen Atlas\n")

    report = {
        "invoice_100771": {},
        "atlas_scan_hits": [],
        "search_results": {},
        "deleted_payment_23112": {},
        "conclusion": "",
    }

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

        # ── Step 1: Find Invoice 100771 ────────────────────────────────────────
        logmsg("="*60)
        logmsg("STEP 1: Find Invoice 100771 (AutoLeap-edited, unknown content)")
        logmsg("="*60)

        txn_100771 = find_invoice_via_audit_log(p, "100771")
        if not txn_100771:
            txn_100771 = find_invoice_via_search(p, "100771")

        if txn_100771:
            logmsg(f"  Found Invoice 100771 at txnId={txn_100771}")
            hist_100771 = get_audit_history(p, txn_100771)
            ss(p, "atlas_inv100771_history")
            versions_100771 = parse_versions(hist_100771)

            logmsg(f"  Has Atlas: {has_atlas(hist_100771)}")
            logmsg(f"  Is Dealer: {is_dealer(hist_100771)}")
            logmsg(f"  Versions ({len(versions_100771)}):")
            for v in versions_100771[:10]:
                logmsg(f"    {v['timestamp'][:26]} | {v['actor'][:22]} | {v['action']}"
                       f" | cust={v['customer'][:30]} | ${v['amount']} | atlas={v['has_atlas']}")

            ps_vs = [v for v in versions_100771 if "Pittstop" in v["actor"]]
            al_vs = [v for v in versions_100771 if "AutoLeap" in v["actor"]]
            report["invoice_100771"] = {
                "txn_id": txn_100771,
                "has_atlas": has_atlas(hist_100771),
                "is_dealer": is_dealer(hist_100771),
                "pittstop_versions": ps_vs,
                "autoleap_versions": al_vs,
                "all_versions": versions_100771,
                "raw": hist_100771[:5000],
            }
        else:
            logmsg("  Invoice 100771 NOT FOUND via audit log or global search")
            report["invoice_100771"] = {"error": "not found"}

        # ── Step 2: Inspect deleted Sterling Kia payment (txnId 23112) ────────
        logmsg("\n" + "="*60)
        logmsg("STEP 2: Inspect deleted Sterling Kia payment (txnId 23112)")
        logmsg("="*60)
        pmt_text, inv_refs, txn_refs = inspect_deleted_payment(p)
        report["deleted_payment_23112"] = {
            "invoice_refs_in_payment": inv_refs,
            "txnid_refs": txn_refs,
            "raw": pmt_text[:3000],
        }

        # If payment references other invoice txnIds, pull those too
        for ref_txn in txn_refs:
            ref_id = int(ref_txn)
            if ref_id != 23112:
                logmsg(f"  Pulling referenced txnId={ref_id}...")
                ref_text = get_audit_history(p, ref_id)
                ss(p, f"atlas_pmt_ref_{ref_id}")
                logmsg(f"  txnId={ref_id}: atlas={has_atlas(ref_text)}, dealer={is_dealer(ref_text)}")
                report["deleted_payment_23112"][f"referenced_txn_{ref_id}"] = ref_text[:2000]

        # ── Step 3: QBO global search for "Atlas" and "Volkswagen" ────────────
        logmsg("\n" + "="*60)
        logmsg("STEP 3: QBO global search for Atlas/Volkswagen")
        logmsg("="*60)
        for term in ["VW Atlas", "Volkswagen Atlas", "Atlas"]:
            links, text = search_qbo_for_term(p, term)
            report["search_results"][term] = {
                "invoice_links": links,
                "has_atlas_in_results": has_atlas(text),
                "excerpt": text[:1500],
            }
            # Pull audit history for any linked invoices not already known
            for link in links[:5]:
                tid = link["txn_id"]
                if tid not in (23136, 23143, 23144):
                    logmsg(f"  Pulling txnId={tid} from search result...")
                    h = get_audit_history(p, tid)
                    ss(p, f"atlas_search_txn_{tid}")
                    v = parse_versions(h)
                    al = any("AutoLeap" in x["actor"] for x in v)
                    logmsg(f"    txnId={tid}: atlas={has_atlas(h)}, dealer={is_dealer(h)}, autoleap={al}")
                    if v: logmsg(f"    Cust: {v[0].get('customer','?')} | Amt: {v[0].get('amount','?')}")
                    link["audit_excerpt"] = h[:1500]
                    link["versions"] = v
                    link["has_atlas"] = has_atlas(h)
                    link["is_dealer"] = is_dealer(h)
                    link["autoleap"] = al

        # ── Step 4: Scan txnId range 23100–23140 ──────────────────────────────
        logmsg("\n" + "="*60)
        logmsg("STEP 4: Scan txnId 23100–23140 for Atlas/dealer/deleted/AutoLeap")
        logmsg("="*60)
        hits = scan_range_for_atlas(p, 23100, 23140)
        report["atlas_scan_hits"] = hits
        logmsg(f"  Total hits in range: {len(hits)}")
        for h in hits:
            logmsg(f"  → txnId={h['txn_id']} | {h['header']} | "
                   f"atlas={h['has_atlas']} | dealer={h['is_dealer']} | "
                   f"deleted={h['deleted']} | autoleap={h['autoleap']}")

        # ── Conclusion ────────────────────────────────────────────────────────
        logmsg("\n" + "="*60)
        logmsg("CONCLUSION")
        logmsg("="*60)

        atlas_hits = [h for h in hits if h["has_atlas"]]
        overwrite_hits = [h for h in hits if h["has_atlas"] and h["autoleap"]]
        deleted_hits   = [h for h in hits if h["is_dealer"] and h["deleted"]]

        if overwrite_hits:
            c = overwrite_hits[0]
            logmsg(f"CONFIRMED: Atlas invoice at txnId={c['txn_id']} was touched by AutoLeap")
            report["conclusion"] = f"Atlas+AutoLeap at txnId={c['txn_id']}"
        elif atlas_hits:
            c = atlas_hits[0]
            logmsg(f"Atlas found at txnId={c['txn_id']} — no AutoLeap involvement")
            report["conclusion"] = f"Atlas at txnId={c['txn_id']} — no AutoLeap"
        elif report["invoice_100771"].get("has_atlas"):
            logmsg("Invoice 100771 contains Atlas reference")
            report["conclusion"] = "Atlas in Invoice 100771"
        else:
            logmsg("No Atlas invoice found with AutoLeap involvement beyond Invoice 100799 (intact)")
            report["conclusion"] = "No additional Atlas invoice found"

        with open(OUT, "w") as f:
            json.dump(report, f, indent=2, default=str)
        logmsg(f"\nReport → {OUT}")
        logmsg("FORENSIC ATLAS COMPLETE")

        logmsg(f"\nSignal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()


if __name__ == "__main__":
    main()
