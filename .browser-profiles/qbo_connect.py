"""
Guaranteed-clean QuickBooks connect window.

Launches a FRESH, visible, NON-persistent browser (zero Intuit cookies) and
navigates to the production connect endpoint, which lands on the QuickBooks
sign-in / authorize screen. The owner signs in with their real Pitt Stop
QuickBooks company and authorizes. We poll the URL and report when the flow
returns to the app (connected) or hits an error.

No developer-account session -> avoids the session conflict that produces the
spurious redirect_uri error. No secrets handled here.
"""
import time, json
from playwright.sync_api import sync_playwright

CONNECT = "https://pitt-stop-internal.vercel.app/api/auth/quickbooks/connect"
STATUS_F = "/tmp/qbo_connect_status"
LOG_F = "/tmp/qbo_connect.log"
ARGS = ["--password-store=basic", "--use-mock-keychain"]

def log(m):
    print(m, flush=True)
    with open(LOG_F, "a") as f: f.write(str(m) + "\n")

def status(s):
    with open(STATUS_F, "w") as f: f.write(s)

def main():
    open(LOG_F, "w").close()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, args=ARGS)
        ctx = browser.new_context()  # fresh, no cookies
        page = ctx.new_page()
        page.bring_to_front()
        try:
            page.goto(CONNECT, wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            log(f"goto err: {e}")
        page.wait_for_timeout(3000)
        log("OPENED url=" + page.url)
        status("SIGN_IN_READY")

        # Poll for outcome up to 15 min: success (back on our domain) or error page.
        deadline = time.time() + 900
        last = ""
        while time.time() < deadline:
            u = page.url
            if u != last:
                log("url=" + u); last = u
            if "pitt-stop-internal.vercel.app/admin/integrations/quickbooks" in u:
                status("CONNECTED"); log("RETURNED TO ADMIN (connected)"); break
            if "/api/auth/quickbooks/callback" in u:
                status("CALLBACK_HIT"); log("callback hit")
            if "/connect/oauth2/error" in u:
                status("OAUTH_ERROR"); log("OAUTH ERROR PAGE")
            time.sleep(2)
        # keep window open a bit so owner can read final state
        page.wait_for_timeout(4000)
        ctx.close(); browser.close()
        log("CLOSED")

if __name__ == "__main__":
    main()
