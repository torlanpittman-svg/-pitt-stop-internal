"""
Drive to Pitt Stop OS app -> Keys & OAuth -> Production. ASSESS ONLY.
Dumps element STRUCTURE (button/label/placeholder text) — never input VALUES,
so no secret is ever logged. Leaves the browser open. Two READY handshakes:
  READY #1 (only if logged out) = owner logged in
  READY #2 = close
"""
import os, time, json
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
SHOTS   = os.path.join(PROJECT, ".browser-profiles", "screenshots")
READY_F = os.path.join(PROJECT, ".browser-profiles", "READY")
LOG_F   = "/tmp/intuit_keys.log"
APP_ID  = "5889e8a3-d8ad-48f0-ac9c-e9a7de38a95a"
ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]
os.makedirs(SHOTS, exist_ok=True)

def log(m):
    print(m, flush=True)
    with open(LOG_F, "a") as f: f.write(m + "\n")

def wait_ready(msg):
    log(f">>> {msg}")
    while not os.path.exists(READY_F): time.sleep(2)
    os.remove(READY_F)

def structure(page, tag):
    """Dump text of interactive elements + input labels — NEVER values."""
    try:
        info = page.evaluate("""() => ({
          buttons: [...document.querySelectorAll('button,a,[role=tab],[role=button]')]
             .map(e=>e.innerText.trim()).filter(t=>t&&t.length<50),
          fields: [...document.querySelectorAll('input,textarea')]
             .map(e=>({label:(e.getAttribute('aria-label')||e.placeholder||e.name||''), type:e.type||''}))
        })""")
        btns = sorted(set([b for b in info['buttons'] if b]))
        log(f"[{tag}] buttons/tabs: {json.dumps(btns)[:1600]}")
        log(f"[{tag}] fields(labels only): {json.dumps(info['fields'])[:1200]}")
    except Exception as e:
        log(f"[{tag}] structure err: {e}")

def click_text(page, txt, timeout=2500):
    try:
        el = page.locator(f"text={txt}").first
        if el.is_visible(timeout=timeout):
            el.click(); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500)
            return True
    except: pass
    return False

def main():
    open(LOG_F, "w").close()
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS)
        page = ctx.new_page(); page.bring_to_front()
        page.goto("https://developer.intuit.com/app/developer/myapps",
                  wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(4000)
        if "accounts.intuit.com" in page.url or "signin" in page.url.lower():
            wait_ready("Owner: log in again in this window, then I signal READY.")
            page.wait_for_timeout(3000)
        log(f"start: {page.url}")

        # Enter workspace + app
        click_text(page, "Pitt Stop OS")
        # click the app card (has AppID text) — try JS click on the card element
        try:
            page.evaluate("""() => {
              const cards=[...document.querySelectorAll('*')].filter(e=>/AppID|5889e8a3|QuickBooks/.test(e.innerText||'') && e.querySelector('a,button'));
              const c=cards.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length)[0];
              const link=c&&c.querySelector('a,button'); if(link) link.click();
            }""")
            page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500)
        except Exception as e:
            log(f"app-card js click err: {e}")
        # fallback: click app name text again
        if "appId" not in page.url and "appdetail" not in page.url.lower():
            click_text(page, "Pitt Stop OS")
        log(f"after app entry: {page.url}")
        structure(page, "app")

        # Navigate to Keys & OAuth
        for t in ["Keys & OAuth", "Keys and OAuth", "Keys & credentials", "Keys"]:
            if click_text(page, t):
                log(f"clicked keys nav: {t}"); break
        page.wait_for_timeout(2500)
        log(f"keys page: {page.url}")
        structure(page, "keys")

        # Look specifically for a Production section / go-live / terms
        for t in ["Production", "Get production keys", "Go live", "Production Settings"]:
            try:
                if page.locator(f"text={t}").first.is_visible(timeout=1200):
                    log(f"PRODUCTION-related element present: '{t}'")
            except: pass

        log("\nAssessment done. Browser open. touch READY to close.")
        wait_ready("touch READY to close")
        ctx.close()

if __name__ == "__main__":
    main()
