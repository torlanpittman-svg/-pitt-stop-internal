"""
Intuit Developer Portal setup — v2.
Goes directly into the Pitt Stop OS app settings → Keys & OAuth → adds redirect URI.
AppID: 5889e8a3-d8ad-48f0-ac9c-e9a7de38a95a
"""
import os, json, time, re
from playwright.sync_api import sync_playwright

PROJECT      = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE      = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
SHOTS        = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F      = os.path.join(PROJECT, ".browser-profiles", "READY")
REPORT_F     = os.path.join(PROJECT, ".browser-profiles", "intuit_setup_report.json")
LOG_F        = "/tmp/intuit_setup.log"

APP_ID       = "5889e8a3-d8ad-48f0-ac9c-e9a7de38a95a"
REDIRECT_URI = "http://localhost:3000/api/auth/quickbooks/callback"

# Intuit app settings URL (Keys & OAuth tab)
KEYS_URL = f"https://developer.intuit.com/dashboard?id=9341457607038670&appid={APP_ID}&tab=keys"

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

os.makedirs(SHOTS, exist_ok=True)

def log(msg):
    print(msg, flush=True)
    with open(LOG_F, "a") as f:
        f.write(msg + "\n")

def ss(page, name):
    try:
        path = f"{SHOTS}/intuit_{name}.png"
        page.screenshot(path=path, full_page=True)
        log(f"  [screenshot] → {name}.png")
    except Exception as e:
        log(f"  [screenshot error] {e}")

def safe_text(page):
    try:
        return page.inner_text("body")
    except:
        return ""

def wait_for_ready(msg):
    if os.path.exists(READY_F):
        os.remove(READY_F); log("READY (immediate)."); return
    log(f"\n>>> {msg}")
    log(f">>> touch {READY_F}")
    while not os.path.exists(READY_F):
        time.sleep(2)
    os.remove(READY_F)
    log("READY.")

def navigate_to_app_keys(page):
    """Try several URL patterns to reach the app Keys & OAuth page."""
    candidates = [
        # Direct app settings URL with tab
        f"https://developer.intuit.com/app/developer/appdashboard#appId={APP_ID}&tab=keys",
        # Dashboard with appid param
        KEYS_URL,
        # Alternative patterns
        f"https://developer.intuit.com/v2/ui#/app/{APP_ID}/keys",
        f"https://developer.intuit.com/dashboard?appid={APP_ID}&tab=keys",
    ]
    for url in candidates:
        log(f"  Trying: {url}")
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(3000)
        text = safe_text(page)
        if any(k in text.lower() for k in ["client id", "client secret", "redirect", "oauth"]):
            log(f"  ✓ Found Keys page at: {page.url}")
            return True
    return False

def main():
    with open(LOG_F, "w") as f: f.write("")

    log("="*70)
    log("Intuit Developer — Keys & OAuth Setup (v2)")
    log(f"App ID: {APP_ID}")
    log(f"Target redirect URI: {REDIRECT_URI}")
    log("="*70)

    report = {
        "app_id": APP_ID,
        "redirect_uri_target": REDIRECT_URI,
        "redirect_uri_was_present": False,
        "redirect_uri_added": False,
        "development_client_id": "",
        "actions_taken": [],
        "needs_manual_approval": [],
        "next_step": "",
        "error": None,
    }

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS,
        )
        page = ctx.new_page()
        page.bring_to_front()

        # ── Step 1: Start at myapps, check login ──────────────────────────
        log("\n[1] Checking login state...")
        page.goto("https://developer.intuit.com/app/developer/myapps",
                  wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(3000)

        if "accounts.intuit.com" in page.url or "signin" in page.url:
            wait_for_ready("Please log in to developer.intuit.com, then touch READY")
            page.wait_for_timeout(3000)

        log(f"  Logged in. Current URL: {page.url}")
        ss(page, "v2_01_logged_in")

        # ── Step 2: Open the Pitt Stop OS app ────────────────────────────
        log("\n[2] Clicking into Pitt Stop OS app...")
        app_entered = False

        # Try clicking the app card directly
        for sel in ["text=Pitt Stop OS", "text=Pitt Stop"]:
            try:
                el = page.locator(sel).first
                if el.is_visible(timeout=3000):
                    el.click()
                    page.wait_for_load_state("domcontentloaded")
                    page.wait_for_timeout(3000)
                    ss(page, "v2_02_app_clicked")
                    log(f"  Clicked app. Now at: {page.url}")
                    app_entered = True
                    break
            except:
                pass

        if not app_entered:
            log("  Couldn't click app card. Trying direct URL navigation...")

        # ── Step 3: Navigate to Keys & OAuth ─────────────────────────────
        log("\n[3] Navigating to Keys & OAuth...")

        # First try clicking a sidebar/tab link on the current page
        on_keys_page = False
        for sel in [
            "text=Keys & OAuth",
            "text=Keys & credentials",
            "a:has-text('Keys')",
            "text=Development Keys",
        ]:
            try:
                el = page.locator(sel).first
                if el.is_visible(timeout=2000):
                    log(f"  Found Keys nav: {sel}")
                    el.click()
                    page.wait_for_load_state("domcontentloaded")
                    page.wait_for_timeout(3000)
                    on_keys_page = True
                    break
            except:
                pass

        if not on_keys_page:
            log("  Keys nav not found in sidebar — trying direct URL patterns...")
            on_keys_page = navigate_to_app_keys(page)

        ss(page, "v2_03_keys_page")
        keys_text = safe_text(page)
        log(f"  Current URL: {page.url}")
        log(f"  Page text (first 1500):\n{keys_text[:1500]}")

        # ── Step 4: Find Development Keys section ────────────────────────
        log("\n[4] Looking for Development Keys section...")

        # Check if we need to expand Development section
        for sel in [
            "text=Development",
            "text=Development Keys",
            "button:has-text('Development')",
        ]:
            try:
                el = page.locator(sel).first
                if el.is_visible(timeout=2000):
                    tag = el.evaluate("e => e.tagName.toLowerCase()")
                    # Only click if it's a button/expandable, not just a heading
                    if tag in ("button", "a", "summary"):
                        log(f"  Expanding development section: {sel}")
                        el.click()
                        page.wait_for_timeout(1500)
                        break
            except:
                pass

        keys_text = safe_text(page)

        # Extract visible Client ID
        cid_m = re.search(r'(?:Client ID|ClientId)[:\s]+([A-Za-z0-9]{20,})', keys_text, re.IGNORECASE)
        if cid_m:
            report["development_client_id"] = cid_m.group(1)
            log(f"  Development Client ID visible: {cid_m.group(1)[:8]}...")

        # ── Step 5: Check existing redirect URIs ─────────────────────────
        log("\n[5] Checking existing redirect URIs...")
        redirect_present = REDIRECT_URI in keys_text
        report["redirect_uri_was_present"] = redirect_present
        log(f"  Target URI present: {redirect_present}")

        # Collect all URLs that look like redirect URIs
        all_urls = re.findall(r'https?://[^\s\n,<>"\']+', keys_text)
        log(f"  All URLs on page: {all_urls[:10]}")

        ss(page, "v2_05_before_add")

        # ── Step 6: Add redirect URI if needed ───────────────────────────
        if not redirect_present:
            log(f"\n[6] Adding redirect URI...")
            added = False

            # Look for Add URI button or input near Redirect URI section
            # Intuit portal typically has an "+ Add URI" button in the redirect section
            for sel in [
                "text=+ Add URI",
                "text=Add URI",
                "button:has-text('+ Add')",
                "[placeholder*='redirect' i]",
                "[placeholder*='URI' i]",
                "[placeholder*='https' i]",
                "input[type='text'][name*='redirect' i]",
                "input[type='url']",
            ]:
                try:
                    el = page.locator(sel).first
                    if el.is_visible(timeout=2000):
                        tag = el.evaluate("e => e.tagName.toLowerCase()")
                        log(f"  Found: {sel} (tag: {tag})")

                        if tag == "input":
                            # Direct input — fill it
                            el.clear()
                            el.fill(REDIRECT_URI)
                            page.wait_for_timeout(500)
                            ss(page, "v2_06a_uri_typed")
                        else:
                            # Button — click to reveal input
                            el.click()
                            page.wait_for_timeout(1000)
                            ss(page, "v2_06b_after_add_click")

                            # Now find the new input that appeared
                            new_inp = None
                            for inp_sel in [
                                "input[placeholder*='redirect' i]",
                                "input[placeholder*='URI' i]",
                                "input[placeholder*='https' i]",
                                "input[type='url']",
                                "input[type='text']",
                            ]:
                                try:
                                    candidates_list = page.locator(inp_sel).all()
                                    for c in reversed(candidates_list):  # last = newest
                                        if c.is_visible(timeout=500):
                                            new_inp = c
                                            log(f"  Found input: {inp_sel}")
                                            break
                                    if new_inp:
                                        break
                                except:
                                    pass

                            if new_inp:
                                new_inp.clear()
                                new_inp.fill(REDIRECT_URI)
                                page.wait_for_timeout(500)
                                ss(page, "v2_06c_uri_typed")
                                log(f"  Typed redirect URI into input")
                            else:
                                log("  Could not find text input after clicking Add")
                                ss(page, "v2_06_no_input_found")
                                break

                        # ── Save ──────────────────────────────────────────
                        page.wait_for_timeout(300)
                        for save_sel in [
                            "button:has-text('Save')",
                            "button:has-text('Update')",
                            "button[type='submit']",
                            "text=Save",
                        ]:
                            try:
                                btn = page.locator(save_sel).first
                                if btn.is_visible(timeout=2000):
                                    log(f"  Clicking save: {save_sel}")
                                    btn.click()
                                    page.wait_for_timeout(3000)
                                    ss(page, "v2_06d_after_save")
                                    added = True
                                    report["redirect_uri_added"] = True
                                    report["actions_taken"].append(f"Added and saved redirect URI: {REDIRECT_URI}")
                                    break
                            except:
                                pass
                        break  # done with outer selector loop
                except:
                    pass

            if not added:
                log("  Auto-add failed. Capturing final state.")
                ss(page, "v2_06_auto_add_failed")
                report["needs_manual_approval"].append(
                    f"Could not add redirect URI automatically.\n"
                    f"In the browser: find 'Redirect URIs' section → click '+ Add URI' → paste:\n"
                    f"  {REDIRECT_URI}\n"
                    f"Then click Save."
                )

        else:
            log(f"  Redirect URI already present — nothing to add.")
            report["actions_taken"].append("Redirect URI already present")

        # ── Step 7: Verify ───────────────────────────────────────────────
        log("\n[7] Final verification...")
        page.wait_for_timeout(2000)
        final_text = safe_text(page)
        confirmed = REDIRECT_URI in final_text
        report["redirect_uri_added"] = confirmed or report["redirect_uri_was_present"]
        log(f"  Redirect URI confirmed in page: {confirmed}")
        ss(page, "v2_07_final")

        # ── Outcome ──────────────────────────────────────────────────────
        if confirmed or report["redirect_uri_was_present"]:
            report["next_step"] = (
                "✓ Intuit app is configured. Redirect URI is set.\n"
                "Next: I will build the OAuth routes in Pitt Stop. When the dev server\n"
                "is running, go to /admin/integrations/quickbooks and click Connect."
            )
        elif report["needs_manual_approval"]:
            report["next_step"] = (
                "Manual step needed: add the redirect URI in the Intuit portal browser window.\n"
                + "\n".join(report["needs_manual_approval"])
            )

        log("\n" + "="*70)
        log("RESULT")
        log(json.dumps(report, indent=2))

        with open(REPORT_F, "w") as f:
            json.dump(report, f, indent=2)

        log(f"\nReport: {REPORT_F}")
        log(f"\nNEXT STEP: {report['next_step']}")

        wait_for_ready("Review browser, then touch READY to close")
        ctx.close()

if __name__ == "__main__":
    main()
