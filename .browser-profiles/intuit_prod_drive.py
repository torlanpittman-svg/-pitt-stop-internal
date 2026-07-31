"""
Drive the Intuit PRODUCTION app setup for Pitt Stop OS.
Navigates to the app, screenshots the production/profile area (NOT the secret
keys), lists visible links/tabs/inputs so we can fill the profile URLs.
Leaves the browser open for the owner. Never reads/screenshots Client Secret.
"""
import os, time, json
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
LOG_F   = "/tmp/intuit_prod.log"
APP_ID  = "5889e8a3-d8ad-48f0-ac9c-e9a7de38a95a"
ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]
os.makedirs(SHOTS, exist_ok=True)

def log(m):
    print(m, flush=True)
    with open(LOG_F, "a") as f: f.write(m + "\n")

def dump(page, tag):
    try:
        info = page.evaluate("""() => ({
          links: [...document.querySelectorAll('a,button,[role=tab]')].map(e=>e.innerText.trim()).filter(t=>t&&t.length<40).slice(0,60),
          inputs: [...document.querySelectorAll('input,textarea')].map(e=>({ph:e.placeholder||'',name:e.name||'',type:e.type||'',label:(e.getAttribute('aria-label')||'')})).slice(0,40),
        })""")
        log(f"[{tag}] tabs/buttons: {json.dumps(info['links'])[:1200]}")
        log(f"[{tag}] inputs: {json.dumps(info['inputs'])[:1200]}")
    except Exception as e:
        log(f"[{tag}] dump err: {e}")

def main():
    open(LOG_F, "w").close()
    log("Driving Intuit production setup…")
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS)
        page = ctx.new_page()
        page.bring_to_front()

        page.goto("https://developer.intuit.com/app/developer/myapps",
                  wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(4000)
        if "accounts.intuit.com" in page.url or "signin" in page.url.lower():
            log("LOGGED OUT — owner must log in again.")
            page.screenshot(path=f"{SHOTS}/intuit_prod_loggedout.png")
        else:
            log(f"Logged in. URL: {page.url}")
            page.screenshot(path=f"{SHOTS}/intuit_prod_myapps.png")
            dump(page, "myapps")

            # Try to enter the app: click Pitt Stop OS twice (workspace then app card)
            for label in ["Pitt Stop OS", "Pitt Stop"]:
                try:
                    el = page.locator(f"text={label}").first
                    if el.is_visible(timeout=2500):
                        el.click(); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500)
                except: pass
            # click app card again if we're at workspace
            try:
                el = page.locator("text=5889e8a3").first
                if el.is_visible(timeout=2000):
                    el.click(); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500)
            except: pass

            log(f"After entering app: {page.url}")
            page.screenshot(path=f"{SHOTS}/intuit_prod_app.png")
            dump(page, "app")

            # Look for a Production tab / Go Live / Settings
            for label in ["Production", "Go Live", "Settings", "App Assessment", "Keys & OAuth"]:
                try:
                    el = page.locator(f"text={label}").first
                    if el.is_visible(timeout=1500):
                        log(f"Found nav: '{label}'")
                except: pass

        log("\nBrowser open for owner. touch READY to close.")
        while not os.path.exists(READY_F):
            time.sleep(3)
        os.remove(READY_F)
        ctx.close()

if __name__ == "__main__":
    main()
