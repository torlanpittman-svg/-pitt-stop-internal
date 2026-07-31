"""
Intuit Developer Portal setup — v3.
Inspect DOM links first, find the real app card href, then navigate precisely.
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
WORKSPACE_URL = "https://developer.intuit.com/dashboard?id=9341457607038670&tab=apps"

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]
os.makedirs(SHOTS, exist_ok=True)

def log(msg):
    print(msg, flush=True)
    with open(LOG_F, "a") as f:
        f.write(msg + "\n")

def ss(page, name):
    try:
        page.screenshot(path=f"{SHOTS}/intuit_v3_{name}.png", full_page=True)
        log(f"  [ss] {name}.png")
    except Exception as e:
        log(f"  [ss error] {e}")

def safe_text(page):
    try: return page.inner_text("body")
    except: return ""

def wait_for_ready(msg):
    if os.path.exists(READY_F):
        os.remove(READY_F); log("READY (immediate)."); return
    log(f"\n>>> {msg}")
    log(f">>> touch {READY_F}")
    while not os.path.exists(READY_F): time.sleep(2)
    os.remove(READY_F); log("READY.")

def dump_links(page):
    """Return all <a> hrefs and button texts visible on the page."""
    return page.evaluate("""() => {
        const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
            text: a.innerText.trim().slice(0, 80),
            href: a.href,
        }));
        const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
            text: b.innerText.trim().slice(0, 80),
        }));
        return { links, buttons };
    }""")

def find_and_click_app_card(page):
    """
    Try multiple strategies to click into the Pitt Stop OS app card:
    1. Find <a> link containing the app UUID
    2. Find <a> link near text '5889e8a3'
    3. Click the card container that contains '5889e8a3' text
    4. Ask for DOM inspection
    """
    # Strategy 1: link with app UUID in href
    try:
        el = page.locator(f'a[href*="{APP_ID}"]').first
        if el.is_visible(timeout=2000):
            href = el.get_attribute("href")
            log(f"  Strategy 1: found link with app UUID in href: {href}")
            el.click()
            page.wait_for_load_state("domcontentloaded")
            page.wait_for_timeout(3000)
            return True
    except: pass

    # Strategy 2: any element containing truncated app ID text, click its parent link
    try:
        # AppID shown as "5889e8a3..." on card
        el = page.locator("text=5889e8a3").first
        if el.is_visible(timeout=2000):
            log("  Strategy 2: found AppID text, clicking ancestor link")
            # Walk up to find a clickable ancestor
            for _ in range(5):
                try:
                    el = el.locator("xpath=..")
                    tag = el.evaluate("e => e.tagName.toLowerCase()")
                    if tag in ("a", "button"):
                        el.click()
                        page.wait_for_load_state("domcontentloaded")
                        page.wait_for_timeout(3000)
                        return True
                except: break
    except: pass

    # Strategy 3: click the card article/div that has 'Pitt Stop OS' AND 'QuickBooks'
    try:
        result = page.evaluate("""() => {
            // Find container element that has both 'Pitt Stop OS' and 'QuickBooks' text
            const all = document.querySelectorAll('article, [class*="card"], [class*="app"], li, div');
            for (const el of all) {
                const t = el.innerText || '';
                if (t.includes('Pitt Stop OS') && t.includes('QuickBooks') && el.children.length > 0) {
                    // Find an <a> inside
                    const link = el.querySelector('a');
                    if (link && link.href) return link.href;
                }
            }
            return null;
        }""")
        if result:
            log(f"  Strategy 3: found card link via DOM scan: {result}")
            page.goto(result, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(3000)
            return True
    except: pass

    # Strategy 4: dump all links for diagnosis
    info = dump_links(page)
    log(f"  All links on page:")
    for lnk in info.get("links", []):
        log(f"    [{lnk['text'][:50]}] → {lnk['href']}")
    log(f"  All buttons: {[b['text'][:40] for b in info.get('buttons', [])]}")
    return False

def find_keys_nav(page):
    """Navigate to the Keys & OAuth tab from inside the app page."""
    for sel in [
        "text=Keys & OAuth",
        "a:has-text('Keys')",
        "text=Development Keys",
        "[href*='keys']",
        "[href*='oauth']",
        "text=OAuth",
    ]:
        try:
            el = page.locator(sel).first
            if el.is_visible(timeout=2000):
                log(f"  Keys nav found: {sel}")
                el.click()
                page.wait_for_load_state("domcontentloaded")
                page.wait_for_timeout(3000)
                return True
        except: pass

    # Check left nav links
    info = dump_links(page)
    log("  Links on app page (looking for keys/oauth):")
    for lnk in info.get("links", []):
        log(f"    [{lnk['text'][:50]}] → {lnk['href']}")
    return False

def add_redirect_uri(page):
    """Find the redirect URI input/button and add our URI."""
    text = safe_text(page)

    if REDIRECT_URI in text:
        log(f"  Redirect URI already present.")
        return "already_present"

    ss(page, "keys_page_before_add")

    # Try to find and click "+ Add URI" or similar
    for sel in [
        "text=+ Add URI",
        "text=Add URI",
        "text=Add Redirect URI",
        "button:has-text('Add')",
        "[data-testid*='add']",
    ]:
        try:
            el = page.locator(sel).first
            if el.is_visible(timeout=2000):
                log(f"  Clicking add control: {sel}")
                el.click()
                page.wait_for_timeout(1000)
                ss(page, "after_add_click")
                break
        except: pass

    # Now find the input that should have appeared
    inp = None
    for sel in [
        "input[placeholder*='redirect' i]",
        "input[placeholder*='URI' i]",
        "input[placeholder*='https' i]",
        "input[placeholder*='url' i]",
        "input[type='url']",
        "input[type='text']",
    ]:
        try:
            candidates = page.locator(sel).all()
            for c in reversed(candidates):
                if c.is_visible(timeout=500):
                    val = c.input_value()
                    if not val or "localhost" not in val:
                        inp = c
                        log(f"  Found input via: {sel}, current value: '{val}'")
                        break
            if inp: break
        except: pass

    if not inp:
        log("  No input found for redirect URI")
        ss(page, "no_input_found")
        return "no_input"

    inp.clear()
    inp.fill(REDIRECT_URI)
    page.wait_for_timeout(400)
    ss(page, "uri_typed")
    log(f"  Typed: {REDIRECT_URI}")

    # Save
    for save_sel in ["button:has-text('Save')", "button:has-text('Update')", "button[type='submit']"]:
        try:
            btn = page.locator(save_sel).first
            if btn.is_visible(timeout=2000):
                log(f"  Clicking save: {save_sel}")
                btn.click()
                page.wait_for_timeout(3000)
                ss(page, "after_save")
                # Verify
                if REDIRECT_URI in safe_text(page):
                    log("  ✓ Redirect URI confirmed saved.")
                    return "saved"
                else:
                    log("  Save clicked but URI not visible in page yet.")
                    return "save_clicked_unverified"
        except: pass

    return "no_save_button"

def main():
    with open(LOG_F, "w") as f: f.write("")

    log("="*70)
    log("Intuit Developer — Keys & OAuth v3 (DOM-aware)")
    log(f"Target: {REDIRECT_URI}")
    log("="*70)

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS,
        )
        page = ctx.new_page()
        page.bring_to_front()

        # ── 1. Load workspace apps page ───────────────────────────────────
        log(f"\n[1] Loading workspace apps page...")
        page.goto(WORKSPACE_URL, wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(4000)

        if "accounts.intuit.com" in page.url or "signin" in page.url.lower():
            wait_for_ready("Log in to developer.intuit.com, then touch READY")
            page.wait_for_timeout(3000)

        log(f"  At: {page.url}")
        ss(page, "01_workspace")

        # ── 2. Click into the Pitt Stop OS app card ───────────────────────
        log(f"\n[2] Entering Pitt Stop OS app...")
        entered = find_and_click_app_card(page)
        log(f"  Entered: {entered}  |  Now at: {page.url}")
        ss(page, "02_after_card_click")

        if not entered:
            # Last resort: wait for user to click the app card manually
            wait_for_ready(
                "Click the 'Pitt Stop OS' app CARD (not the workspace title) in the browser, "
                "then touch READY once you're inside the app settings"
            )
            page.wait_for_timeout(2000)

        log(f"  App page URL: {page.url}")
        ss(page, "02b_app_page")

        # ── 3. Navigate to Keys & OAuth ───────────────────────────────────
        log(f"\n[3] Finding Keys & OAuth...")
        on_keys = find_keys_nav(page)
        log(f"  on_keys_page: {on_keys}  |  URL: {page.url}")
        ss(page, "03_keys")

        if not on_keys:
            wait_for_ready(
                "Click 'Keys & OAuth' in the left sidebar, then touch READY"
            )
            page.wait_for_timeout(2000)
            log(f"  After manual nav: {page.url}")
            ss(page, "03b_keys_manual")

        # ── 4. Add redirect URI ───────────────────────────────────────────
        log(f"\n[4] Adding redirect URI...")
        result = add_redirect_uri(page)
        log(f"  Result: {result}")
        ss(page, "04_final")

        # ── Summary ───────────────────────────────────────────────────────
        report = {
            "entered_app": entered,
            "found_keys_page": on_keys,
            "add_result": result,
            "final_url": page.url,
            "redirect_uri_confirmed": result in ("saved", "already_present"),
        }
        with open(REPORT_F, "w") as f:
            json.dump(report, f, indent=2)

        log("\n" + "="*70)
        if report["redirect_uri_confirmed"]:
            log("✓ COMPLETE — Redirect URI is set.")
            log("Next: build OAuth routes in Pitt Stop OS.")
        else:
            log(f"RESULT: {result}")
            log(f"Manual action may be needed — check browser window.")
        log("="*70)
        log(json.dumps(report, indent=2))

        wait_for_ready("Review browser result, then touch READY to close")
        ctx.close()

if __name__ == "__main__":
    main()
