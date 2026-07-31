"""
Persistent, file-controlled Intuit Developer driver.

Stays alive the entire session so the owner's in-memory login survives (Intuit
uses session cookies that do NOT persist across browser restarts). The parent
process controls it by writing a JSON command to /tmp/intuit_cmd, which this
loop executes and then deletes, writing results to /tmp/intuit_driver.log and a
short status to /tmp/intuit_result.

SECURITY: only the `ingest_keys` command touches secret values, and it pipes
them straight into `vercel env add` via stdin. Values are NEVER printed, logged,
screenshotted, or returned — only their lengths and pass/fail.

Commands (JSON in /tmp/intuit_cmd):
  {"cmd":"status"}                       -> report login state + current URL
  {"cmd":"goto","url":"..."}             -> navigate
  {"cmd":"dump"}                         -> dump page structure (no values)
  {"cmd":"click","text":"..."}           -> click first element matching text
  {"cmd":"fill","label":"...","value":"..."}  -> fill a field by label (URLs only; non-secret)
  {"cmd":"ingest_keys"}                  -> read prod Client ID+Secret, pipe to Vercel
  {"cmd":"shot","name":"x"}              -> screenshot (use only on non-secret pages)
  {"cmd":"close"}                        -> shut down
"""
import os, sys, time, json, subprocess
from playwright.sync_api import sync_playwright

PROJECT  = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE  = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
SHOTS    = os.path.join(PROJECT, ".browser-profiles", "screenshots")
LOG_F    = "/tmp/intuit_driver.log"
CMD_F    = "/tmp/intuit_cmd"
RES_F    = "/tmp/intuit_result"
APP_ID   = "5889e8a3-d8ad-48f0-ac9c-e9a7de38a95a"
SCOPE    = "team_TGngJQMpvAgMrRXyILLlPNk6"
ARGS = ["--password-store=basic", "--use-mock-keychain", "--disable-features=PasswordManager"]
os.makedirs(SHOTS, exist_ok=True)

def log(m):
    print(m, flush=True)
    with open(LOG_F, "a") as f: f.write(str(m) + "\n")

def result(s):
    with open(RES_F, "w") as f: f.write(str(s))

def is_in(u):
    return ("developer.intuit.com" in u) and ("accounts.intuit.com" not in u) and ("sign-in" not in u.lower())

def logged_in(ctx):
    return any(is_in(p.url) for p in ctx.pages)

def active_page(ctx):
    # Prefer a logged-in developer.intuit.com tab; else the last tab.
    for p in ctx.pages:
        if is_in(p.url):
            return p
    return ctx.pages[-1] if ctx.pages else None

def dump(page, tag="dump"):
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
        btns = sorted(set(b for b in info['buttons'] if b))
        heads = sorted(set(h for h in info['headings'] if h))
        log(f"[{tag}] url: {page.url}")
        log(f"[{tag}] buttons/tabs: {json.dumps(btns)[:2400]}")
        log(f"[{tag}] headings/labels: {json.dumps(heads)[:2400]}")
        log(f"[{tag}] fields(labels+flags only): {json.dumps(info['fields'])[:2400]}")
    except Exception as e:
        log(f"[{tag}] dump err: {e}")

def do_click(page, txt):
    try:
        el = page.locator(f"text={txt}").first
        if el.is_visible(timeout=3000):
            el.click(); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2500)
            return True
    except Exception as e:
        log(f"click err: {e}")
    return False

def do_fill(page, label, value):
    # Match input/textarea by aria-label/placeholder/name/adjacent label. URLs only.
    try:
        found = page.evaluate("""(label) => {
          const norm = s => (s||'').toLowerCase();
          const inps = [...document.querySelectorAll('input,textarea')];
          let idx = -1;
          inps.forEach((inp,i)=>{
            let l = inp.getAttribute('aria-label')||inp.name||inp.placeholder||'';
            if(!l){ const p=inp.closest('div,section,li,tr,form'); const lab=p&&p.querySelector('label'); if(lab) l=lab.innerText; }
            if(idx<0 && norm(l).includes(norm(label))) { idx=i; }
          });
          if(idx>=0){ inps[idx].setAttribute('data-fill-target','1'); return true; }
          return false;
        }""", label)
        if not found:
            return False
        el = page.locator("[data-fill-target='1']").first
        el.fill(value)
        page.evaluate("""() => { const e=document.querySelector("[data-fill-target='1']"); if(e) e.removeAttribute('data-fill-target'); }""")
        return True
    except Exception as e:
        log(f"fill err: {e}")
        return False

def vercel(args, stdin=None):
    r = subprocess.run(["npx", "vercel", *args, "--scope", SCOPE],
                       input=stdin, capture_output=True, text=True)
    return r.returncode, (r.stdout or "") + (r.stderr or "")

def set_prod_var(name, value):
    vercel(["env", "rm", name, "production", "--yes"])
    code, out = vercel(["env", "add", name, "production"], stdin=value)
    ok = code == 0 or ("added" in out.lower()) or ("created" in out.lower()) or ("success" in out.lower())
    log(f"  {name}: len={len(value)} -> {'set in Vercel production' if ok else 'FAILED'}")
    if not ok:
        log(f"    (vercel: {' '.join(out.split()[-12:])[:200]})")
    return ok

def ingest_keys(page):
    """Read production Client ID + Secret from the DOM, pipe to Vercel. No values logged."""
    # Reveal any hidden secret first (click Show/Reveal/Copy toggles is unnecessary for input.value).
    data = page.evaluate("""() => {
      const norm = s => (s||'').toLowerCase();
      function ctxHeading(el){
        // nearest preceding heading text within 6 ancestors
        let node = el, hops=0;
        while(node && hops<8){
          let sib = node.previousElementSibling;
          while(sib){
            if(/^(H1|H2|H3|H4)$/.test(sib.tagName) || sib.getAttribute && sib.getAttribute('role')==='heading'){
              return sib.innerText||'';
            }
            const h = sib.querySelector && sib.querySelector('h1,h2,h3,h4,[role=heading]');
            if(h) return h.innerText||'';
            sib = sib.previousElementSibling;
          }
          node = node.parentElement; hops++;
        }
        return '';
      }
      function labelFor(inp){
        let l = inp.getAttribute('aria-label')||inp.name||inp.placeholder||'';
        if(!l){ const p=inp.closest('div,section,li,tr,form'); const lab=p&&p.querySelector('label'); if(lab) l=lab.innerText; }
        return l;
      }
      return [...document.querySelectorAll('input,textarea')].map(inp=>({
        label: labelFor(inp), ctx: ctxHeading(inp), val: inp.value||''
      }));
    }""")

    def norm(s): return (s or "").lower()
    # candidate classification
    prod_id = prod_secret = None
    id_dbg = sec_dbg = None
    for f in data:
        lab, ctx, val = norm(f["label"]), norm(f["ctx"]), f["val"]
        is_prod = ("production" in lab) or ("production" in ctx)
        if ("client id" in lab or "clientid" in lab) and val and len(val) >= 20:
            if is_prod and prod_id is None:
                prod_id = val; id_dbg = f'label="{f["label"]}" ctx="{f["ctx"]}"'
        if ("client secret" in lab or "clientsecret" in lab or "secret" in lab) and val and len(val) >= 20:
            if is_prod and prod_secret is None:
                prod_secret = val; sec_dbg = f'label="{f["label"]}" ctx="{f["ctx"]}"'

    # Fallback: if exactly two client-id / two client-secret style fields exist and page is the
    # production view, pick the ones whose ctx mentions production; else report ambiguity.
    log(f"ingest: matched_id={'yes' if prod_id else 'no'} ({id_dbg}); "
        f"matched_secret={'yes' if prod_secret else 'no'} ({sec_dbg})")

    if not prod_id or not prod_secret:
        # Log non-secret inventory to help refine (labels + ctx + length only, NEVER value)
        inv = [{"label": f["label"], "ctx": f["ctx"], "len": len(f["val"])} for f in data if f["val"]]
        log("ingest: candidates(labels+ctx+len only)=" + json.dumps(inv)[:1600])
        result("INGEST_AMBIGUOUS")
        return
    if prod_id == prod_secret:
        log("ingest: id == secret — refusing")
        result("INGEST_AMBIGUOUS")
        return

    log("ingest: writing to Vercel production…")
    a = set_prod_var("QUICKBOOKS_CLIENT_ID", prod_id)
    b = set_prod_var("QUICKBOOKS_CLIENT_SECRET", prod_secret)
    # scrub locals
    prod_id = prod_secret = None
    result("INGEST_OK" if (a and b) else "INGEST_FAILED")

def main():
    open(LOG_F, "w").close()
    for f in (CMD_F, RES_F):
        try: os.remove(f)
        except OSError: pass
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=PROFILE, headless=False,
            viewport={"width": 1440, "height": 900}, args=ARGS)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.bring_to_front()
        try:
            page.goto("https://developer.intuit.com/app/developer/myapps",
                      wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            log(f"goto err: {e}")
        page.wait_for_timeout(3000)
        log("DRIVER_READY url=" + page.url)
        log("LOGIN_STATE=" + ("in" if logged_in(ctx) else "out"))
        result("READY")

        deadline = time.time() + 3600  # up to 60 min
        while time.time() < deadline:
            if not os.path.exists(CMD_F):
                time.sleep(1.5); continue
            try:
                cmd = json.loads(open(CMD_F).read() or "{}")
            except Exception as e:
                cmd = {}; log(f"cmd parse err: {e}")
            try: os.remove(CMD_F)
            except OSError: pass
            pg = active_page(ctx) or page
            c = cmd.get("cmd")
            log(f"--- CMD: {json.dumps(cmd)[:300]}")
            if c == "close":
                result("CLOSED"); break
            elif c == "status":
                log("LOGIN_STATE=" + ("in" if logged_in(ctx) else "out"))
                log("URLS=" + json.dumps([p.url for p in ctx.pages]))
                result("in" if logged_in(ctx) else "out")
            elif c == "goto":
                try:
                    pg.goto(cmd["url"], wait_until="domcontentloaded", timeout=45000)
                    pg.wait_for_timeout(3000); result("GOTO_DONE")
                    log("now: " + pg.url)
                except Exception as e:
                    log(f"goto err: {e}"); result("GOTO_ERR")
            elif c == "dump":
                dump(pg, cmd.get("tag", "dump")); result("DUMP_DONE")
            elif c == "click":
                ok = do_click(pg, cmd["text"]); result("CLICK_" + ("OK" if ok else "MISS"))
                log("after click url: " + pg.url)
            elif c == "fill":
                ok = do_fill(pg, cmd["label"], cmd["value"]); result("FILL_" + ("OK" if ok else "MISS"))
            elif c == "shot":
                try:
                    pth = os.path.join(SHOTS, cmd.get("name", "shot") + ".png")
                    pg.screenshot(path=pth); log("shot: " + pth); result("SHOT_DONE")
                except Exception as e:
                    log(f"shot err: {e}"); result("SHOT_ERR")
            elif c == "ingest_keys":
                ingest_keys(pg)
            else:
                log("unknown cmd"); result("UNKNOWN")
        ctx.close()
        log("DRIVER_EXIT")

if __name__ == "__main__":
    main()
