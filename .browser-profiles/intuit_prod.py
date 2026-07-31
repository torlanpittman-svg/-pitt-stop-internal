"""
Open the Intuit Developer portal at the Pitt Stop OS app to drive PRODUCTION
setup. Does NOT read or screenshot the production keys (secret — owner only).
Assesses login state + app profile, leaves the window open for the owner.
"""
import os, time
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

def main():
    open(LOG_F, "w").close()
    log("Opening Intuit Developer portal for PRODUCTION setup…")
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS)
        page = ctx.new_page()
        page.bring_to_front()
        page.goto("https://developer.intuit.com/app/developer/myapps",
                  wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(4000)

        url = page.url
        logged_out = "accounts.intuit.com" in url or "signin" in url.lower()
        log(f"URL: {url}")
        log(f"logged_out: {logged_out}")
        try:
            page.screenshot(path=f"{SHOTS}/intuit_prod_landing.png")
            log("screenshot: intuit_prod_landing.png")
        except Exception as e:
            log(f"screenshot err: {e}")

        if logged_out:
            log(">>> Owner must log in (and complete MFA). Leaving browser open.")
        else:
            log(">>> Session active. Owner can open the app → Production settings.")

        log("\nBrowser stays open. touch READY to close when done.")
        while not os.path.exists(READY_F):
            time.sleep(3)
        os.remove(READY_F)
        ctx.close()

if __name__ == "__main__":
    main()
