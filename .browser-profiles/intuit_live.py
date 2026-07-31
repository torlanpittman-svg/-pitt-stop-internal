"""
Single long-lived Intuit session: open → owner logs in → (SAME context) drive
the production app setup. Two READY handshakes:
  READY #1  = owner has logged in (I signal after they confirm)
  READY #2  = done, close browser
Never reads/screenshots the production Client Secret.
"""
import os, time, json
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
STEP_F  = os.path.join(PROJECT, ".browser-profiles", "STEP")   # secondary signal
LOG_F   = "/tmp/intuit_live.log"
ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]
os.makedirs(SHOTS, exist_ok=True)

def log(m):
    print(m, flush=True)
    with open(LOG_F, "a") as f: f.write(m + "\n")

def wait(signal_path, msg):
    log(f">>> {msg}")
    while not os.path.exists(signal_path):
        time.sleep(2)
    os.remove(signal_path)

def dump(page, tag):
    try:
        info = page.evaluate("""() => ({
          nav: [...document.querySelectorAll('a,button,[role=tab]')].map(e=>e.innerText.trim()).filter(t=>t&&t.length<45),
          inputs: [...document.querySelectorAll('input,textarea')].map(e=>({ph:e.placeholder||'',name:e.name||'',aria:(e.getAttribute('aria-label')||'')})),
        })""")
        nav = [x for x in info['nav'] if x][:70]
        log(f"[{tag}] nav: {json.dumps(nav)[:1500]}")
        log(f"[{tag}] inputs: {json.dumps(info['inputs'])[:1500]}")
    except Exception as e:
        log(f"[{tag}] dump err: {e}")

def main():
    open(LOG_F, "w").close()
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
            wait(READY_F, "Owner: log in + MFA in this window, then I'll signal READY.")
            page.wait_for_timeout(3000)

        log(f"After login gate. URL: {page.url}")
        try: page.screenshot(path=f"{SHOTS}/live_myapps.png")
        except: pass
        dump(page, "myapps")

        # Enter the app (workspace card, then app card)
        for label in ["Pitt Stop OS", "Pitt Stop"]:
            try:
                el = page.locator(f"text={label}").first
                if el.is_visible(timeout=2500):
                    el.click(); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500)
            except: pass
        try:
            el = page.locator("text=5889e8a3").first
            if el.is_visible(timeout=2000):
                el.click(); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500)
        except: pass

        log(f"App page: {page.url}")
        try: page.screenshot(path=f"{SHOTS}/live_app.png")
        except: pass
        dump(page, "app")

        # Hold open for interactive driving; owner touches STEP after each manual step.
        log("\nBrowser is open and logged in. Holding for driving.")
        wait(READY_F, "touch READY to close when production setup is complete.")
        ctx.close()

if __name__ == "__main__":
    main()
