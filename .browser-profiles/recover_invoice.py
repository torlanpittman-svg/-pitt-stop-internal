"""
Get the original Sterling Subaru line items from QBO's audit history.

Strategy:
  1. Open the invoice list, click View/Edit on invoice 100803 and 100802
     to get each invoice's QBO internal txnId from the URL.
  2. Navigate to /app/audithistory?txnId=X to see the full version history,
     including the original Sterling Subaru state before AutoLeap overwrote it.
"""
import os, json, re, time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "recovery_details.json")

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

def log(msg): print(msg, flush=True)

def ss(page, name):
    try: page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)
    except: pass
    log(f"  screenshot: {name}.png")

def wait_for_ready():
    if os.path.exists(READY_F):
        os.remove(READY_F)
        log("READY.")
        return
    log(f"\nWaiting for READY:  touch {READY_F}")
    while not os.path.exists(READY_F):
        time.sleep(3)
    os.remove(READY_F)
    log("READY.")


def get_txn_id_for_invoice(page, invoice_no):
    """
    Open the QBO invoice list, find the row for invoice_no,
    click View/Edit, and return the txnId from the resulting URL.
    """
    log(f"\n── Getting txnId for invoice {invoice_no} ──")

    page.goto("https://qbo.intuit.com/app/invoices",
              wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(4000)
    ss(page, f"invoicelist_{invoice_no}")

    # Find the row in the invoice list that has this invoice number
    # Try: locate a cell with the exact invoice number text
    row = page.locator(f"text={invoice_no}").first
    if row.count() == 0:
        log(f"  Invoice {invoice_no} not found in visible list — trying to scroll or search")
        # Try the QBO global search
        try:
            search = page.locator("[placeholder*='Find transactions']").first
            search.fill(invoice_no)
            page.wait_for_timeout(2000)
            ss(page, f"invoicelist_{invoice_no}_search")
        except:
            pass

    # Click View/Edit on the row containing this invoice number
    log(f"  Looking for View/Edit link near {invoice_no}...")

    # Use JavaScript to find the row and click its View/Edit anchor
    txn_id = page.evaluate(f"""async () => {{
        // Find a cell whose text is exactly the invoice number
        const cells = Array.from(document.querySelectorAll('td, [class*="cell"], [class*="number"]'));
        const target = cells.find(c => c.textContent.trim() === '{invoice_no}');
        if (!target) return null;
        // Walk up to the row, then find the View/Edit link
        let row = target.closest('tr, [class*="row"], [class*="item"]');
        if (!row) row = target.parentElement?.parentElement;
        if (!row) return null;
        // Find an anchor or button with View/Edit text
        const link = row.querySelector('a[href*="invoice"]') ||
                     row.querySelector('a') ||
                     Array.from(row.querySelectorAll('*')).find(el =>
                         el.children.length === 0 &&
                         (el.textContent.trim() === 'View/Edit' || el.textContent.trim() === 'View')
                     );
        if (!link) return null;
        if (link.href) return link.href;
        // No href — click and return url after navigation
        link.click();
        return 'clicked';
    }}""")

    log(f"  JS result: {txn_id}")

    if txn_id and txn_id.startswith("http"):
        # Got the URL directly
        m = re.search(r'txnId=(\d+)', txn_id)
        if m:
            return m.group(1)
        # Try navigating to it
        page.goto(txn_id, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3000)
    elif txn_id == "clicked":
        page.wait_for_timeout(3000)
    else:
        # Try Playwright locator: find text = invoice_no, go to its row's link
        log(f"  JS approach failed, trying Playwright locator...")
        try:
            cell = page.get_by_text(invoice_no, exact=True).first
            # Navigate to parent row
            row_el = cell.locator("xpath=ancestor::tr[1]")
            if row_el.count() == 0:
                row_el = cell.locator("xpath=ancestor::*[contains(@class,'row')][1]")
            link = row_el.locator("a").first
            if link.count() > 0:
                href = link.get_attribute("href")
                log(f"  Found link href: {href}")
                if href:
                    page.goto(f"https://qbo.intuit.com{href}" if href.startswith("/") else href,
                              wait_until="domcontentloaded", timeout=30000)
                    page.wait_for_timeout(3000)
                else:
                    link.click()
                    page.wait_for_timeout(3000)
        except Exception as e:
            log(f"  Playwright locator error: {e}")

    # Check URL for txnId
    current = page.url
    log(f"  Current URL: {current}")
    m = re.search(r'txnId=(\d+)', current)
    if m:
        return m.group(1)

    # Try to extract from page content
    content = page.inner_text("body")[:2000]
    m = re.search(r'txnId[=:](\d+)', content)
    if m:
        return m.group(1)
    m = re.search(r'"txnId"\s*:\s*"?(\d+)', content)
    if m:
        return m.group(1)

    log(f"  Could not find txnId for {invoice_no}")
    ss(page, f"invoice_{invoice_no}_notfound")
    return None


def get_audit_history(page, txn_id, label):
    """Navigate to the audit history page for a txnId and capture all versions."""
    log(f"\n── Audit history for txnId={txn_id} ({label}) ──")

    url = f"https://qbo.intuit.com/app/audithistory?txnId={txn_id}"
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(5000)

    ss(page, f"audithistory_{label}")
    text = page.inner_text("body")
    log(f"  Text (first 1000):\n{text[:1000]}")
    return text


def main():
    log("Invoice recovery — reading original line items from QBO audit history")

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,
            viewport={"width": 1440, "height": 900},
            args=ARGS,
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

        findings = {}

        # Invoice 100803 — now shows Maria Houchins, but full history includes Sterling Subaru
        txn_103 = get_txn_id_for_invoice(p, "100803")
        log(f"\nInvoice 100803 txnId: {txn_103}")
        if txn_103:
            findings["100803"] = {"txn_id": txn_103}
            findings["100803"]["audit_history"] = get_audit_history(p, txn_103, "inv100803")
        else:
            findings["100803"] = {"error": "could not get txnId"}

        # Invoice 100802 — now shows phill dorsett
        txn_102 = get_txn_id_for_invoice(p, "100802")
        log(f"\nInvoice 100802 txnId: {txn_102}")
        if txn_102:
            findings["100802"] = {"txn_id": txn_102}
            findings["100802"]["audit_history"] = get_audit_history(p, txn_102, "inv100802")
        else:
            findings["100802"] = {"error": "could not get txnId"}

        with open(OUT, "w") as f:
            json.dump(findings, f, indent=2)
        log(f"\nResults → {OUT}")

        log("\nBrowser staying open.")
        log(f"Signal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()


if __name__ == "__main__":
    main()
