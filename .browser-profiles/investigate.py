"""
Read-only accounting investigation — AutoLeap + QuickBooks Online.

Browser : Playwright bundled Chromium (NOT system Chrome)
Profile : .browser-profiles/accounting-investigation  (persistent, no Keychain)
Keychain: BLOCKED via --password-store=basic --use-mock-keychain
Actions : READ-ONLY — no edits, no syncs, no saves

READY signal: create the file  .browser-profiles/READY
(or `touch .browser-profiles/READY` in a terminal)
"""
import os, json, time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PROJECT   = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE   = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
OUT       = os.path.join(PROJECT, ".browser-profiles", "findings.json")
SHOTS     = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F   = os.path.join(PROJECT, ".browser-profiles", "READY")

ARGS = [
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-features=PasswordManager",
]

os.makedirs(SHOTS, exist_ok=True)

def log(msg): print(msg, flush=True)

def screenshot(page, name):
    p = os.path.join(SHOTS, f"{name}.png")
    try:
        page.screenshot(path=p, full_page=True)
        log(f"  📸 {name}.png")
    except Exception as e:
        log(f"  screenshot failed: {e}")
    return p

def safe_text(page):
    try:
        return page.inner_text("body")
    except:
        return ""

def goto(page, url, wait_el=None, timeout=45000):
    """Navigate and optionally wait for a selector before returning."""
    page.goto(url, wait_until="domcontentloaded", timeout=timeout)
    if wait_el:
        try:
            page.wait_for_selector(wait_el, timeout=10000)
        except PWTimeout:
            pass
    page.wait_for_timeout(2000)

def wait_for_ready():
    # Do NOT delete a pre-existing READY file here.
    # If it already exists from a pre-seed, honour it immediately.
    if os.path.exists(READY_F):
        os.remove(READY_F)
        log("READY signal already present — starting immediately.")
        return
    log("")
    log("=" * 60)
    log("Browser open — two tabs:")
    log("  Tab 1: QuickBooks Online  (qbo.intuit.com)")
    log("  Tab 2: AutoLeap           (app.myautoleap.com)")
    log("")
    log("Log into BOTH sites and complete any MFA.")
    log("When both dashboards are visible, signal READY:")
    log(f"  touch {READY_F}")
    log("(or tell Claude 'I'm logged in' and Claude will send it)")
    log("Polling every 3 s…")
    log("=" * 60)
    while not os.path.exists(READY_F):
        time.sleep(3)
    os.remove(READY_F)
    log("READY — starting investigation.")


# ── AutoLeap ──────────────────────────────────────────────────────────────────

def autoleap(ctx):
    F = {}
    p = ctx.new_page()
    p.bring_to_front()

    # --- QuickBooks integration settings ---
    log("\n[AutoLeap] → QB integration settings")
    goto(p, "https://app.myautoleap.com/#/settings/integrations/carfax",
         wait_el="li.tertiary-nav-item")

    try:
        p.locator("li.tertiary-nav-item").filter(has_text="Quickbooks").click()
        p.wait_for_selector(".autocomplete-input", timeout=10000)
        p.wait_for_timeout(1500)
    except PWTimeout:
        log("  [warn] QB sidebar item slow to load")

    F["al_qb_url"] = p.url
    body = safe_text(p)
    log(body[:1200])
    F["al_qb_text"] = body
    screenshot(p, "01_al_qb_settings")

    # Toggle state — use input specifically, not the wrapping component
    try:
        el = p.locator("input[id='auto-sync-qbo-on-invoice-or-finalize']")
        F["auto_sync_on_invoicing"] = el.is_checked() if el.count() > 0 else None
    except Exception as e:
        F["auto_sync_on_invoicing"] = f"error: {e}"

    # Product mappings
    mappings = {}
    try:
        for inp in p.locator(".autocomplete-input").all():
            ph  = inp.get_attribute("placeholder") or ""
            val = inp.input_value() or ""
            if ph:
                mappings[ph] = val
    except:
        pass
    F["product_mappings"] = mappings
    log(f"  auto_sync = {F['auto_sync_on_invoicing']}")
    log(f"  mappings  = {json.dumps(mappings)}")

    # --- Reports ---
    log("\n[AutoLeap] → Reports")
    try:
        p.locator("a.nav-link").filter(has_text="Reports").click()
        p.wait_for_load_state("domcontentloaded")
        p.wait_for_timeout(2000)
    except Exception as e:
        log(f"  [warn] Reports nav: {e}")
    rtext = safe_text(p)
    F["al_reports_text"] = rtext[:4000]
    log(rtext[:600])
    screenshot(p, "02_al_reports")

    # --- Try invoice / transaction list routes ---
    log("\n[AutoLeap] → Invoice/transaction list")
    for route in [
        "https://app.myautoleap.com/#/reports/invoice-history",
        "https://app.myautoleap.com/#/reports/sales",
        "https://app.myautoleap.com/#/invoices",
        "https://app.myautoleap.com/#/transactions",
    ]:
        try:
            goto(p, route)
            t = safe_text(p)
            if len(t) > 200 and "404" not in t[:100] and "not found" not in t[:100].lower():
                F[f"al_route_{route.split('/')[-1]}"] = t[:3000]
                log(f"  {route}: {t[:300]}")
                screenshot(p, f"03_al_{route.split('/')[-1]}")
                break
        except:
            pass

    p.close()
    return F


# ── QuickBooks ────────────────────────────────────────────────────────────────

def quickbooks(ctx):
    F = {}
    p = ctx.new_page()
    p.bring_to_front()

    # --- Audit Log ---
    log("\n[QBO] → Audit Log")
    goto(p, "https://qbo.intuit.com/app/auditlog", timeout=60000)
    p.wait_for_timeout(4000)
    log(f"  url: {p.url}")
    t = safe_text(p)
    log(t[:2500])
    F["qbo_audit_url"]  = p.url
    F["qbo_audit_text"] = t[:8000]
    screenshot(p, "04_qbo_audit_log")

    # --- Sales settings (Custom Transaction Numbers) ---
    log("\n[QBO] → Settings → Sales")
    goto(p, "https://qbo.intuit.com/app/settings?view=sales", timeout=30000)
    p.wait_for_timeout(2500)
    t = safe_text(p)
    log(t[:2000])
    F["qbo_sales_url"]  = p.url
    F["qbo_sales_text"] = t[:5000]
    screenshot(p, "05_qbo_sales_settings")

    # --- Advanced settings ---
    log("\n[QBO] → Settings → Advanced")
    goto(p, "https://qbo.intuit.com/app/settings?view=advanced", timeout=30000)
    p.wait_for_timeout(2500)
    t = safe_text(p)
    log(t[:2000])
    F["qbo_advanced_text"] = t[:5000]
    screenshot(p, "06_qbo_advanced_settings")

    # --- Connected Apps ---
    log("\n[QBO] → Connected Apps")
    goto(p, "https://qbo.intuit.com/app/settings?view=connectedapps", timeout=30000)
    p.wait_for_timeout(3000)
    t = safe_text(p)
    log(t[:2000])
    F["qbo_apps_url"]  = p.url
    F["qbo_apps_text"] = t[:5000]
    screenshot(p, "07_qbo_connected_apps")

    # --- Invoice list ---
    log("\n[QBO] → Invoices")
    goto(p, "https://qbo.intuit.com/app/invoices", timeout=45000)
    p.wait_for_timeout(4000)
    t = safe_text(p)
    log(t[:2000])
    F["qbo_invoices_url"]  = p.url
    F["qbo_invoices_text"] = t[:6000]
    screenshot(p, "08_qbo_invoices")

    p.close()
    return F


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    log("Investigation browser starting.")
    log(f"  Profile  : {PROFILE}")
    log(f"  Chromium : Playwright bundled (no system Chrome, no Keychain)")
    log(f"  Flags    : {' '.join(ARGS)}")

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,
            viewport={"width": 1440, "height": 900},
            args=ARGS,
        )

        # Open login tabs
        qbo = ctx.new_page()
        qbo.goto("https://qbo.intuit.com", wait_until="domcontentloaded", timeout=30000)
        qbo.bring_to_front()

        al = ctx.new_page()
        al.goto("https://app.myautoleap.com", wait_until="domcontentloaded", timeout=30000)
        al.bring_to_front()

        wait_for_ready()

        qbo.close()
        al.close()

        all_findings = {}

        try:
            all_findings["autoleap"] = autoleap(ctx)
        except Exception as e:
            log(f"[AutoLeap] FATAL: {e}")
            all_findings["autoleap_error"] = str(e)

        try:
            all_findings["quickbooks"] = quickbooks(ctx)
        except Exception as e:
            log(f"[QBO] FATAL: {e}")
            all_findings["qbo_error"] = str(e)

        with open(OUT, "w") as f:
            json.dump(all_findings, f, indent=2)
        log(f"\nFindings → {OUT}")
        log(f"Shots    → {SHOTS}/")
        log("\nBrowser left open for manual inspection. Ctrl-C to close.")
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            pass

        ctx.close()


if __name__ == "__main__":
    main()
