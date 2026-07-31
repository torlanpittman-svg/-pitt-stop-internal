"""
Send AutoLeap support ticket via in-app chat.
Uses the saved investigation profile (already authenticated to AutoLeap).
READ-ONLY NAVIGATION — only sends the support message, no invoice edits.
"""
import os, time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "accounting-investigation")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")

ARGS = [
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-features=PasswordManager",
]

SUBJECT = "Integration Bug — AutoLeap silently overwrites existing QBO invoices when syncing (upsert by DocNumber)"

BODY = """Hi AutoLeap Support,

We have a critical integration bug affecting our QuickBooks Online data.

Account: Pitt Stop Detail & Auto Sales
Priority: Critical — financial data loss is occurring

DESCRIPTION:
When AutoLeap syncs an invoice whose DocNumber already exists in QBO (because a manual QBO invoice was created with the same number), AutoLeap is performing a QBO UPDATE on the existing invoice rather than returning an error. The existing invoice's customer, line items, and total are completely replaced with AutoLeap's invoice data — with no warning shown anywhere in AutoLeap or QBO.

CONFIRMED EVIDENCE (from QBO Audit Log):

Invoice 100803:
- Jul 22, 3:52 PM: Manually created in QBO for Sterling Subaru, $200
- Jul 22, 5:57 PM: Manually edited to $400
- Jul 24, 6:00 PM: AutoLeap System edited it (still shows Sterling Subaru, $400)
- Jul 24, 6:00 PM: AutoLeap System edited again — now shows Maria Houchins, $2,148.40
- Jul 24, 6:00 PM: AutoLeap System applied payment to Maria Houchins, $2,148.40
The Sterling Subaru invoice is gone — completely replaced.

Invoice 100802:
- Jul 22, 2:06 PM: Manually created in QBO for Sterling Subaru, $400
- Jul 24, 5:12 PM: AutoLeap System edited it (still shows Sterling Subaru, $400)
- Jul 24, 5:56 PM: AutoLeap System edited again — now shows phill dorsett, $683.48
- Jul 24, 5:56 PM: AutoLeap System applied payment to phill dorsett, $669.50
Again — Sterling Subaru invoice gone, replaced.

ROOT CAUSE SUSPECTED:
AutoLeap's QBO sync uses an upsert pattern: search for an existing QBO invoice by DocNumber, and if found, UPDATE it by its internal QBO Id rather than failing with a duplicate-number error. This is why no Error 6140 fires and no warning appears in AutoLeap or QBO.

CURRENT STATE:
- Auto-sync is OFF (already disabled)
- The per-invoice "Sync to QuickBooks" button is what triggered both overwrites
- We have suspended use of that button until this is resolved

QUESTIONS:
1. Can you confirm or correct this root cause assessment?
2. Did this behavior change when Intuit deprecated API minorversions 1-74 in August 2025?
3. What is the fix timeline?
4. Are any sync operations safe to perform until the fix is deployed?
5. Is there a way to audit which other invoices may have been overwritten?

Thank you,
Pitt Stop Detail & Auto Sales"""

def log(msg): print(msg, flush=True)

def wait_for_ready():
    if os.path.exists(READY_F):
        os.remove(READY_F)
        log("READY signal present — continuing.")
        return
    log("")
    log("=" * 60)
    log(f"Signal READY when done:  touch {READY_F}")
    log("=" * 60)
    while not os.path.exists(READY_F):
        time.sleep(3)
    os.remove(READY_F)
    log("READY — continuing.")


def main():
    log("Launching saved investigation profile...")

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,
            viewport={"width": 1440, "height": 900},
            args=ARGS,
        )

        p = ctx.new_page()
        p.bring_to_front()

        # Navigate to AutoLeap
        log("\nNavigating to AutoLeap...")
        p.goto("https://app.myautoleap.com", wait_until="domcontentloaded", timeout=30000)
        p.wait_for_timeout(3000)

        if "login" in p.url.lower() or "signin" in p.url.lower():
            log("Session expired — please log in, then touch .browser-profiles/READY")
            wait_for_ready()
            p.wait_for_timeout(3000)

        log(f"  URL: {p.url}")
        p.screenshot(path=f"{SHOTS}/ticket_01_loaded.png")
        log("Screenshot: ticket_01_loaded.png")

        # Wait for Intercom and Angular to fully initialize
        log("\nWaiting 15s for Intercom and Angular to initialize...")
        p.wait_for_timeout(15000)

        log("  Frames after wait:")
        for fr in p.frames:
            log(f"    {fr.url[:100]}")

        # ── Approach 1: click the visible "?" help icon in the AutoLeap nav bar ──
        log("\nLooking for ? help button in nav bar...")
        clicked = False

        # Inspect page for any element matching the ? icon
        all_els = p.evaluate("""() => {
            const results = [];
            document.querySelectorAll('a, button, [role=button]').forEach(el => {
                const txt = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim();
                if (txt === '?' || txt.toLowerCase().includes('help') || txt.toLowerCase().includes('support')) {
                    results.push({tag: el.tagName, txt, cls: el.className.slice(0,60)});
                }
            });
            return results;
        }""")
        log(f"  Help-like elements: {all_els}")

        for sel in [
            "[aria-label*='Help']",
            "[aria-label*='help']",
            "[title*='Help']",
            "[title*='help']",
            "a.help-btn",
            "button.help-btn",
            ".help-button",
            ".help-icon",
            "nav a[href*='help']",
        ]:
            try:
                el = p.locator(sel)
                if el.count() > 0:
                    el.first.click()
                    log(f"  Clicked: {sel}")
                    clicked = True
                    break
            except Exception as e:
                log(f"  {sel}: {e}")

        if not clicked:
            try:
                el = p.get_by_role("link", name="?")
                if el.count() == 0:
                    el = p.get_by_role("button", name="?")
                if el.count() > 0:
                    el.first.click()
                    log("  Clicked ? by role")
                    clicked = True
            except Exception as e:
                log(f"  role-based click: {e}")

        if not clicked:
            # From screenshot: ? icon is in top-right nav, roughly x=1302, y=30
            log("  Falling back to mouse click at ? position (1302, 30)")
            p.mouse.click(1302, 30)
            clicked = True

        p.wait_for_timeout(4000)
        p.screenshot(path=f"{SHOTS}/ticket_02_after_help_click.png")
        log("Screenshot: ticket_02_after_help_click.png")

        # ── Look for Intercom that should now be open ──
        log("\nPolling for Intercom frame (up to 15s)...")
        intercom_frame = None
        for _ in range(15):
            for fr in p.frames:
                if "intercom" in fr.url.lower():
                    intercom_frame = fr
                    break
            if intercom_frame:
                break
            p.wait_for_timeout(1000)

        if intercom_frame:
            log(f"  Intercom frame found: {intercom_frame.url[:80]}")
        else:
            log("  Intercom frame not found. All frames:")
            for fr in p.frames:
                log(f"    {fr.url[:100]}")
            log("  Will try to type into any visible textarea/input...")

        # ── Type the message ──
        log("\nLooking for message input field...")
        typed = False

        # Try Intercom frame first
        if intercom_frame:
            for sel in [
                "[data-testid='messenger-input-field']",
                ".intercom-composer-input",
                "[placeholder*='essage']",
                "[placeholder*='ype']",
                "[contenteditable='true']",
                "textarea",
            ]:
                try:
                    el = intercom_frame.locator(sel)
                    if el.count() > 0:
                        el.first.fill(f"{SUBJECT}\n\n{BODY}")
                        log(f"  Typed into Intercom: {sel}")
                        typed = True
                        break
                except Exception as e:
                    log(f"    {sel}: {e}")

        # Try all frames
        if not typed:
            for fr in p.frames:
                for sel in ["[contenteditable='true']", "textarea", "[placeholder*='essage']"]:
                    try:
                        el = fr.locator(sel)
                        if el.count() > 0:
                            el.first.fill(f"{SUBJECT}\n\n{BODY}")
                            log(f"  Typed into frame {fr.url[:40]}: {sel}")
                            typed = True
                            break
                    except:
                        pass
                if typed:
                    break

        if typed:
            p.screenshot(path=f"{SHOTS}/ticket_03_message_composed.png")
            log("Screenshot: ticket_03_message_composed.png")
            log("")
            log("=" * 60)
            log("MESSAGE IS COMPOSED IN THE CHAT WINDOW.")
            log("Please review it and press SEND (or Enter) in the browser.")
            log(f"Then:  touch {READY_F}")
            log("=" * 60)
        else:
            log("")
            log("=" * 60)
            log("Could not auto-type the message.")
            log("Please manually open the support chat (? button, top-right)")
            log("and paste the following message:")
            log("")
            log(f"Subject: {SUBJECT}")
            log("")
            log(BODY)
            log("")
            log(f"After sending:  touch {READY_F}")
            log("=" * 60)

        wait_for_ready()

        p.screenshot(path=f"{SHOTS}/ticket_04_sent.png")
        log("Screenshot: ticket_04_sent.png")

        log("\nBrowser staying open 30s for review...")
        time.sleep(30)
        ctx.close()
        log("Done.")


if __name__ == "__main__":
    main()
