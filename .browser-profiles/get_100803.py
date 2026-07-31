"""
Get invoice 100803 audit history using known txnId=23144.
"""
import os, json, time
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
OUT     = os.path.join(PROJECT, ".browser-profiles", "recovery_100803.json")

ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

def log(msg): print(msg, flush=True)

def wait_for_ready():
    if os.path.exists(READY_F):
        os.remove(READY_F)
        log("READY."); return
    log(f"Waiting for READY:  touch {READY_F}")
    while not os.path.exists(READY_F):
        time.sleep(3)
    os.remove(READY_F)
    log("READY.")

def main():
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS,
        )
        p = ctx.new_page()
        p.bring_to_front()

        p.goto("https://qbo.intuit.com", wait_until="domcontentloaded", timeout=30000)
        p.wait_for_timeout(3000)

        if "signin" in p.url.lower() or "accounts.intuit" in p.url.lower():
            log("QBO session expired — please log in.")
            wait_for_ready()
            p.wait_for_timeout(2000)

        log(f"QBO: {p.url}")

        # Navigate directly to invoice 100803's audit history (txnId=23144)
        log("Navigating to audithistory for txnId=23144 (invoice 100803)...")
        p.goto("https://qbo.intuit.com/app/audithistory?txnId=23144",
               wait_until="domcontentloaded", timeout=45000)

        # Wait for content — poll until we see Sterling Subaru or enough text
        log("Waiting for page content...")
        for i in range(20):
            text = p.inner_text("body")
            if "Sterling Subaru" in text or "Complete Detail" in text or len(text) > 2000:
                log(f"  Content loaded after {i*2}s ({len(text)} chars)")
                break
            p.wait_for_timeout(2000)
        else:
            log("  Timed out waiting for Sterling Subaru — capturing anyway")

        text = p.inner_text("body")
        p.screenshot(path=f"{SHOTS}/audithistory_100803_full.png", full_page=True)
        log(f"  Total text length: {len(text)}")
        log(f"  First 500:\n{text[:500]}")

        with open(OUT, "w") as f:
            json.dump({"txn_id": "23144", "audit_history": text}, f, indent=2)
        log(f"\nSaved to {OUT}")

        log("\nBrowser staying open.")
        log(f"Signal done:  touch {READY_F}")
        wait_for_ready()
        ctx.close()

if __name__ == "__main__":
    main()
