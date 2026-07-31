"""
Intuit Developer portal setup for Pitt Stop Internal.

Steps:
1. Open developer.intuit.com and find the Pitt Stop Internal app
2. Inspect the current page / state
3. Navigate to Keys & OAuth
4. Add/verify redirect URI
5. Report what was found and what needs manual approval
"""
import os, json, time
from playwright.sync_api import sync_playwright

PROJECT   = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE   = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
SHOTS     = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F   = os.path.join(PROJECT, ".browser-profiles", "READY")
REPORT_F  = os.path.join(PROJECT, ".browser-profiles", "intuit_setup_report.json")
LOG_F     = "/tmp/intuit_setup.log"

REDIRECT_URI = "http://localhost:3000/api/auth/quickbooks/callback"

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

os.makedirs(SHOTS, exist_ok=True)

def log(msg):
    print(msg)
    with open(LOG_F, "a") as f:
        f.write(msg + "\n")

def ss(page, name):
    try:
        path = f"{SHOTS}/intuit_{name}.png"
        page.screenshot(path=path, full_page=True)
        log(f"  [screenshot] {path}")
    except Exception as e:
        log(f"  [screenshot error] {e}")

def safe_text(page):
    try:
        return page.inner_text("body")
    except:
        return ""

def wait_for_ready(prompt_msg):
    if os.path.exists(READY_F):
        os.remove(READY_F)
        log("READY signal found immediately.")
        return
    log(f"\n>>> {prompt_msg}")
    log(f">>> When done, run:  touch {READY_F}")
    while not os.path.exists(READY_F):
        time.sleep(2)
    os.remove(READY_F)
    log("READY.")

def main():
    log("\n" + "="*70)
    log("Intuit Developer Portal Setup — Pitt Stop Internal")
    log("="*70)

    report = {
        "app_found": False,
        "current_page": "",
        "assessment_required": False,
        "redirect_uri_present": False,
        "redirect_uri_added": False,
        "keys_found": {},
        "actions_taken": [],
        "needs_manual_approval": [],
        "next_step": "",
    }

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,
            viewport={"width": 1440, "height": 900},
            args=ARGS,
        )
        page = ctx.new_page()
        page.bring_to_front()

        # ── 1. Go to developer portal ──────────────────────────────────────
        log("\n[1] Opening Intuit Developer portal...")
        page.goto("https://developer.intuit.com/app/developer/myapps", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3000)
        ss(page, "01_myapps")

        url = page.url
        text = safe_text(page)
        report["current_page"] = url
        log(f"  URL: {url}")

        # Check login state
        if "signin" in url.lower() or "accounts.intuit.com" in url.lower() or "login" in url.lower():
            log("  Not logged in — waiting for manual login...")
            wait_for_ready("Please log in to developer.intuit.com, then touch READY")
            page.wait_for_timeout(3000)
            ss(page, "01b_after_login")
            text = safe_text(page)

        log(f"  Page text excerpt: {text[:300]}")

        # ── 2. Find the app ────────────────────────────────────────────────
        log("\n[2] Looking for Pitt Stop Internal app...")

        # Try clicking the app if visible
        app_found = False
        for selector in [
            "text=Pitt Stop Internal",
            "text=pitt-stop-internal",
            "text=Pitt Stop",
            "[data-testid*='app']",
        ]:
            try:
                el = page.locator(selector).first
                if el.is_visible(timeout=2000):
                    log(f"  Found app via selector: {selector}")
                    el.click()
                    page.wait_for_load_state("domcontentloaded")
                    page.wait_for_timeout(2000)
                    app_found = True
                    report["app_found"] = True
                    report["actions_taken"].append(f"Clicked app: {selector}")
                    ss(page, "02_app_home")
                    break
            except:
                continue

        if not app_found:
            # List all visible app names for debugging
            log("  App not auto-found. Capturing page for review...")
            ss(page, "02_app_not_found")
            log(f"  Full page text:\n{safe_text(page)[:2000]}")
            wait_for_ready("Please click on 'Pitt Stop Internal' app in the browser, then touch READY")
            page.wait_for_timeout(2000)
            ss(page, "02b_after_manual_click")
            report["app_found"] = True

        current_url = page.url
        current_text = safe_text(page)
        report["current_page"] = current_url
        log(f"  Now at: {current_url}")

        # ── 3. Check for App Assessment / Production access flow ────────────
        log("\n[3] Checking for App Assessment requirement...")
        assessment_keywords = [
            "app assessment", "production access", "production keys",
            "apply for production", "get production keys"
        ]
        assessment_found = any(kw in current_text.lower() for kw in assessment_keywords)
        report["assessment_required"] = assessment_found
        log(f"  Assessment required: {assessment_found}")

        if assessment_found:
            log("  Assessment keywords found in page. Checking if we can bypass with Development keys...")
            ss(page, "03_assessment_page")

        # ── 4. Navigate to Keys & OAuth ───────────────────────────────────
        log("\n[4] Navigating to Keys & OAuth...")

        nav_success = False
        for selector in [
            "text=Keys & OAuth",
            "text=Keys & credentials",
            "text=Keys",
            "a[href*='keys']",
            "a[href*='oauth']",
            "[data-testid*='keys']",
        ]:
            try:
                el = page.locator(selector).first
                if el.is_visible(timeout=2000):
                    log(f"  Found nav via: {selector}")
                    el.click()
                    page.wait_for_load_state("domcontentloaded")
                    page.wait_for_timeout(2000)
                    nav_success = True
                    report["actions_taken"].append(f"Navigated to Keys & OAuth via: {selector}")
                    ss(page, "04_keys_oauth")
                    break
            except:
                continue

        if not nav_success:
            log("  Could not auto-navigate. Checking current page for key fields...")
            ss(page, "04_nav_failed")

        keys_text = safe_text(page)
        log(f"  Keys page text (first 1000):\n{keys_text[:1000]}")

        # Extract Client ID if visible
        import re
        client_id_m = re.search(r'Client ID[:\s]+([A-Za-z0-9]{20,})', keys_text)
        if client_id_m:
            report["keys_found"]["client_id_visible"] = True
            log(f"  Client ID visible on page: yes")

        # ── 5. Check redirect URIs ─────────────────────────────────────────
        log("\n[5] Checking redirect URIs...")

        redirect_present = REDIRECT_URI in keys_text
        report["redirect_uri_present"] = redirect_present
        log(f"  Target URI: {REDIRECT_URI}")
        log(f"  Already present: {redirect_present}")

        # Look for existing redirect URIs
        redirect_m = re.findall(r'(https?://[^\s\n,<>"\']+)', keys_text)
        existing_redirects = [u for u in redirect_m if "redirect" in keys_text[max(0, keys_text.find(u)-50):keys_text.find(u)+50].lower()
                              or "callback" in u.lower() or "redirect" in u.lower()]
        log(f"  Existing redirect-like URIs found: {existing_redirects}")
        report["keys_found"]["existing_redirects"] = existing_redirects

        # ── 6. Add redirect URI if missing ────────────────────────────────
        if not redirect_present:
            log(f"\n[6] Adding redirect URI: {REDIRECT_URI}")

            # Try to find Add / + button near redirect URIs section
            added = False
            for selector in [
                "text=Add URI",
                "text=+ Add URI",
                "text=Add Redirect URI",
                "button:has-text('Add')",
                "text=Add link",
                "[placeholder*='redirect']",
                "[placeholder*='URI']",
                "[placeholder*='url']",
            ]:
                try:
                    el = page.locator(selector).first
                    if el.is_visible(timeout=2000):
                        log(f"  Found add control: {selector}")
                        el.click()
                        page.wait_for_timeout(500)

                        # If it's an input, type the URI; if button, look for new input
                        tag = el.evaluate("el => el.tagName.toLowerCase()")
                        if tag == "input":
                            el.fill(REDIRECT_URI)
                        else:
                            # Button was clicked — look for newly appeared input
                            inp = page.locator("input[placeholder*='redirect'], input[placeholder*='URI'], input[placeholder*='url']").last
                            if inp.is_visible(timeout=2000):
                                inp.fill(REDIRECT_URI)
                            else:
                                # Try any last visible text input
                                inp = page.locator("input[type='text'], input[type='url']").last
                                inp.fill(REDIRECT_URI)

                        page.wait_for_timeout(500)
                        ss(page, "06_uri_entered")
                        log(f"  Entered redirect URI")

                        # Save / confirm
                        for save_sel in ["text=Save", "button:has-text('Save')", "button[type='submit']"]:
                            try:
                                btn = page.locator(save_sel).first
                                if btn.is_visible(timeout=1500):
                                    log(f"  Clicking save: {save_sel}")
                                    btn.click()
                                    page.wait_for_timeout(2000)
                                    ss(page, "06b_after_save")
                                    added = True
                                    report["redirect_uri_added"] = True
                                    report["actions_taken"].append(f"Added redirect URI: {REDIRECT_URI}")
                                    break
                            except:
                                continue
                        break
                except:
                    continue

            if not added:
                log("  Could not auto-add redirect URI. Capturing state for review.")
                ss(page, "06_manual_needed")
                report["needs_manual_approval"].append(
                    f"Add redirect URI manually: {REDIRECT_URI}"
                )
        else:
            log("  Redirect URI already present — no action needed.")
            report["actions_taken"].append("Redirect URI already present — skipped")

        # ── 7. Verify final state ──────────────────────────────────────────
        log("\n[7] Verifying final state...")
        page.wait_for_timeout(2000)
        final_text = safe_text(page)
        report["redirect_uri_present"] = REDIRECT_URI in final_text
        ss(page, "07_final_state")
        log(f"  Redirect URI confirmed in page: {report['redirect_uri_present']}")

        # ── 8. Look for OAuth endpoint info ───────────────────────────────
        log("\n[8] Checking OAuth endpoints...")
        # Note the authorization URL format for our implementation
        report["oauth_auth_url"] = "https://appcenter.intuit.com/connect/oauth2"
        report["oauth_token_url"] = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
        report["oauth_revoke_url"] = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"

        # ── 9. Assessment check — report but do NOT submit ────────────────
        if assessment_found:
            log("\n[9] App Assessment detected — NOT submitting (requires your approval)")
            report["needs_manual_approval"].append(
                "App Assessment form was found. Review docs/CLAUDE_HANDOFF.md — "
                "assessment is only required to publish to other companies. "
                "For connecting your own company, Development keys are sufficient. "
                "Do NOT submit the assessment without reviewing it first."
            )

        # ── Summary ────────────────────────────────────────────────────────
        if report["redirect_uri_present"]:
            report["next_step"] = (
                "Redirect URI is set. Return to Pitt Stop OS and I will now build "
                "the OAuth routes (Phase 0b). When the dev server is running, "
                "go to /admin/integrations/quickbooks and click Connect."
            )
        else:
            report["next_step"] = (
                f"Redirect URI could not be added automatically. "
                f"In the Intuit Developer portal → Keys & OAuth, add:\n"
                f"  {REDIRECT_URI}\n"
                f"Then return here."
            )

        log("\n" + "="*70)
        log("SUMMARY")
        log("="*70)
        log(json.dumps(report, indent=2))

        with open(REPORT_F, "w") as f:
            json.dump(report, f, indent=2)
        log(f"\nReport saved: {REPORT_F}")

        log("\nInspection complete. Browser will stay open for you to review.")
        wait_for_ready("Review the browser, then touch READY to close")
        ctx.close()

if __name__ == "__main__":
    with open(LOG_F, "w") as f:
        f.write("")
    main()
