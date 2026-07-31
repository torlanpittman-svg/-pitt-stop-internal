"""
Quick login-state probe. Launches the persistent Intuit profile, opens the
developer portal, waits briefly, and reports the URL + login state across ALL
tabs. No secrets. Closes after reporting.
"""
import os, sys, time, json
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
LOG_F = "/tmp/intuit_probe.log"
ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

def log(m):
    print(m, flush=True)
    with open(LOG_F, "a") as f: f.write(str(m) + "\n")

def is_in(u):
    return ("developer.intuit.com" in u) and ("accounts.intuit.com" not in u) and ("sign-in" not in u.lower())

def main():
    open(LOG_F, "w").close()
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=True,
            viewport={"width": 1440, "height": 900}, args=ARGS)
        page = ctx.new_page()
        try:
            page.goto("https://developer.intuit.com/app/developer/myapps",
                      wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            log(f"goto err: {e}")
        page.wait_for_timeout(6000)
        urls = [p.url for p in ctx.pages]
        log("URLS=" + json.dumps(urls))
        any_in = any(is_in(u) for u in urls)
        log("LOGGED_IN=" + str(any_in))
        ctx.close()

if __name__ == "__main__":
    main()
