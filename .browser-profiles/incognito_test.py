"""
Fresh (non-persistent / incognito) context test of the production OAuth connect.
Hits our connect endpoint, follows the redirect to Intuit, and reports the FINAL
URL + any on-page error text. Intuit validates redirect_uri before login, so a
logged-out context still reveals error-vs-authorize. No secrets involved.
"""
import sys, json
from playwright.sync_api import sync_playwright

URL = "https://pitt-stop-internal.vercel.app/api/auth/quickbooks/connect"
SHOT = "/Users/torlanpittman/Projects/pitt-stop-internal/.browser-profiles/screenshots/incognito_oauth.png"

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context()  # fresh, no cookies/cache
        page = ctx.new_page()
        try:
            page.goto(URL, wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            print("goto err:", e)
        page.wait_for_timeout(5000)
        final = page.url
        print("FINAL_URL=" + final)
        # capture visible error text if present
        try:
            txt = page.evaluate("() => (document.body.innerText||'').slice(0,600)")
            print("BODY=" + json.dumps(txt))
        except Exception as e:
            print("body err:", e)
        try:
            page.screenshot(path=SHOT)
            print("shot saved")
        except Exception as e:
            print("shot err:", e)
        ctx.close(); browser.close()

if __name__ == "__main__":
    main()
