"""
READ-ONLY assessment of the Intuit Developer -> Pitt Stop OS -> Keys & OAuth
(Production) page. Learns login state, navigation structure, remaining app
profile requirements, and whether production keys are present/revealable.

SECURITY: never reads, prints, screenshots, or logs any secret VALUE. Only
element structure (button text, field labels/placeholders, section headings)
and boolean presence flags. No writes, no clicks that mutate state.

Exit codes:
  0 = assessment completed (see /tmp/intuit_assess.log)
  2 = logged out (owner MFA/login required)
"""
import os, sys, time, json
from playwright.sync_api import sync_playwright

PROJECT = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
LOG_F   = "/tmp/intuit_assess.log"
APP_ID  = "5889e8a3-d8ad-48f0-ac9c-e9a7de38a95a"
ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]

def log(m):
    print(m, flush=True)
    with open(LOG_F, "a") as f: f.write(str(m) + "\n")

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
    """Dump interactive element TEXT + input LABELS only. Never values."""
    try:
        info = page.evaluate("""() => ({
          buttons: [...document.querySelectorAll('button,a,[role=tab],[role=button]')]
             .map(e=>e.innerText.trim()).filter(t=>t&&t.length<60),
          headings: [...document.querySelectorAll('h1,h2,h3,h4,legend,label')]
             .map(e=>e.innerText.trim()).filter(t=>t&&t.length<80),
          fields: [...document.querySelectorAll('input,textarea')]
             .map(e=>({label:(e.getAttribute('aria-label')||e.placeholder||e.name||''),
                       type:e.type||'', readonly:e.readOnly||false, empty:!e.value})),
        })""")
        btns = sorted(set([b for b in info['buttons'] if b]))
        heads = sorted(set([h for h in info['headings'] if h]))
        log(f"[{tag}] url: {page.url}")
        log(f"[{tag}] buttons/tabs: {json.dumps(btns)[:2000]}")
        log(f"[{tag}] headings/labels: {json.dumps(heads)[:2000]}")
        log(f"[{tag}] fields(labels+flags only): {json.dumps(info['fields'])[:2000]}")
    except Exception as e:
        log(f"[{tag}] structure err: {e}")

def presence_flags(page, tag):
    """Boolean flags about production keys / requirements. No values."""
    terms = ["Production", "Get production", "Go live", "Production Settings",
             "Client ID", "Client Secret", "Reveal", "Show", "Copy",
             "Host domain", "Launch URL", "App URLs", "End User License",
             "Privacy Policy", "Terms of Service", "Redirect URI",
             "requirements", "complete your app profile", "Save", "Publish",
             "Diagnostics", "App assessment"]
    found = {}
    for t in terms:
        try:
            found[t] = page.locator(f"text={t}").first.is_visible(timeout=600)
        except Exception:
            found[t] = False
    log(f"[{tag}] presence: {json.dumps(found)}")

def main():
    open(LOG_F, "w").close()
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
        page.wait_for_timeout(5000)

        url = page.url
        if "accounts.intuit.com" in url or "signin" in url.lower() or "/signin" in url.lower():
            log(f"LOGGED_OUT url={url}")
            ctx.close()
            sys.exit(2)
        log(f"LOGGED_IN start_url={url}")
        structure(page, "myapps")

        # Enter app: try direct deep link first (most reliable)
        deep = f"https://developer.intuit.com/app/developer/dashboard?appId={APP_ID}"
        try:
            page.goto(deep, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3500)
        except Exception as e:
            log(f"deep link err: {e}")
        # fallback: click the app name text
        if APP_ID not in page.url and "appId" not in page.url:
            click_text(page, "Pitt Stop OS")
            click_text(page, "Pitt Stop OS")
        log(f"after app entry: {page.url}")
        structure(page, "app")
        presence_flags(page, "app")

        # Keys & OAuth navigation
        for t in ["Keys & OAuth", "Keys and OAuth", "Keys & credentials",
                  "Production Settings", "Production", "Keys"]:
            if click_text(page, t):
                log(f"clicked nav: {t}")
                break
        page.wait_for_timeout(3000)
        structure(page, "keys")
        presence_flags(page, "keys")

        # If there is a Production tab/subsection, click it (read-only view)
        for t in ["Production", "Production Settings", "Production keys"]:
            if click_text(page, t):
                log(f"clicked production subsection: {t}")
                page.wait_for_timeout(2500)
                structure(page, "keys_production")
                presence_flags(page, "keys_production")
                break

        log("ASSESSMENT_DONE")
        ctx.close()

if __name__ == "__main__":
    main()
