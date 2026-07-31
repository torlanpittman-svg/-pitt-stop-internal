"""
Long-lived Intuit Developer session driver.
Phase 1: open sign-in, poll until owner completes login + MFA (human-only).
Phase 2: once logged in, navigate to Pitt Stop OS -> Keys & OAuth and dump the
         production page STRUCTURE (no secret values) to the log.
Phase 3: hold the browser open (session alive) until READY file appears.

SECURITY: never reads/prints/screenshots secret VALUES. Structure only.
Status handshake via files so the parent can coordinate without stdin:
  STATUS file: writes SIGN_IN_WAIT -> LOGGED_IN -> ASSESS_DONE
  READY file : touch to close the browser
"""
import os, sys, time, json
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
LOG_F    = "/tmp/intuit_session.log"
STATUS_F = "/tmp/intuit_status"
READY_F  = "/tmp/intuit_ready"
APP_ID   = "5889e8a3-d8ad-48f0-ac9c-e9a7de38a95a"
ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

def log(m):
    print(m, flush=True)
    with open(LOG_F, "a") as f: f.write(str(m) + "\n")

def status(s):
    with open(STATUS_F, "w") as f: f.write(s)
    log(f"STATUS={s}")

def logged_in(page):
    u = page.url
    return ("developer.intuit.com" in u) and ("accounts.intuit.com" not in u) and ("sign-in" not in u.lower())

def click_text(page, txt, timeout=2500):
    try:
        el = page.locator(f"text={txt}").first
        if el.is_visible(timeout=timeout):
            el.click(); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500)
            return True
    except Exception:
        pass
    return False

def structure(page, tag):
    try:
        info = page.evaluate("""() => ({
          buttons: [...document.querySelectorAll('button,a,[role=tab],[role=button]')]
             .map(e=>e.innerText.trim()).filter(t=>t&&t.length<60),
          headings: [...document.querySelectorAll('h1,h2,h3,h4,legend,label,[role=heading]')]
             .map(e=>e.innerText.trim()).filter(t=>t&&t.length<90),
          fields: [...document.querySelectorAll('input,textarea')]
             .map(e=>({label:(e.getAttribute('aria-label')||e.placeholder||e.name||''),
                       type:e.type||'', readonly:e.readOnly||false, empty:!e.value})),
        })""")
        btns = sorted(set([b for b in info['buttons'] if b]))
        heads = sorted(set([h for h in info['headings'] if h]))
        log(f"[{tag}] url: {page.url}")
        log(f"[{tag}] buttons/tabs: {json.dumps(btns)[:2200]}")
        log(f"[{tag}] headings/labels: {json.dumps(heads)[:2200]}")
        log(f"[{tag}] fields(labels+flags only): {json.dumps(info['fields'])[:2200]}")
    except Exception as e:
        log(f"[{tag}] structure err: {e}")

def presence(page, tag):
    terms = ["Production", "Get production", "Production Settings", "Client ID",
             "Client Secret", "Reveal", "Show", "Copy", "Host domain", "Launch URL",
             "End User License", "Privacy Policy", "Terms", "Redirect URI",
             "requirements", "app profile", "Save", "Submit", "Diagnostics"]
    found = {}
    for t in terms:
        try: found[t] = page.locator(f"text={t}").first.is_visible(timeout=500)
        except Exception: found[t] = False
    log(f"[{tag}] presence: {json.dumps(found)}")

def main():
    open(LOG_F, "w").close()
    for f in (STATUS_F, READY_F):
        try: os.remove(f)
        except OSError: pass
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS)
        page = ctx.new_page(); page.bring_to_front()
        try:
            page.goto("https://developer.intuit.com/app/developer/myapps",
                      wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            log(f"goto err: {e}")
        page.wait_for_timeout(4000)

        if not logged_in(page):
            status("SIGN_IN_WAIT")
            log(">>> Owner: log in + complete MFA in the open window.")
            deadline = time.time() + 900  # 15 min
            while time.time() < deadline and not logged_in(page):
                time.sleep(3)
            if not logged_in(page):
                status("SIGN_IN_TIMEOUT")
                log("Timed out waiting for login. Holding open.")
        if logged_in(page):
            status("LOGGED_IN")
            page.wait_for_timeout(2500)

            # Enter app dashboard via deep link
            deep = f"https://developer.intuit.com/app/developer/dashboard?appId={APP_ID}"
            try:
                page.goto(deep, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3500)
            except Exception as e:
                log(f"deep link err: {e}")
            if APP_ID not in page.url and "appId" not in page.url:
                click_text(page, "Pitt Stop OS"); click_text(page, "Pitt Stop OS")
            log(f"app entry url: {page.url}")
            structure(page, "app"); presence(page, "app")

            for t in ["Keys & OAuth", "Keys and OAuth", "Keys & credentials",
                      "Production Settings", "Production", "Keys"]:
                if click_text(page, t):
                    log(f"clicked nav: {t}"); break
            page.wait_for_timeout(3000)
            structure(page, "keys"); presence(page, "keys")

            for t in ["Production", "Production Settings", "Production keys"]:
                if click_text(page, t):
                    log(f"clicked production subsection: {t}")
                    page.wait_for_timeout(2500)
                    structure(page, "keys_production"); presence(page, "keys_production")
                    break
            status("ASSESS_DONE")

        log(">>> Holding browser open. touch /tmp/intuit_ready to close.")
        deadline = time.time() + 1800  # keep alive up to 30 min
        while time.time() < deadline and not os.path.exists(READY_F):
            time.sleep(3)
        try: os.remove(READY_F)
        except OSError: pass
        ctx.close()

if __name__ == "__main__":
    main()
