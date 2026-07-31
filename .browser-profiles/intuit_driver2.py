"""
Persistent, file-controlled Intuit Developer driver (v2).

Adds precise DOM tooling so form fields that share generic names can be targeted
by their VISIBLE label, plus a general read-only `eval` for inspection.

Stays alive so the owner's in-memory Intuit session survives (Intuit login does
NOT persist across browser restarts).

Control: write JSON to /tmp/intuit_cmd; result summary -> /tmp/intuit_result;
verbose -> /tmp/intuit_driver.log.

Commands:
  {"cmd":"status"}
  {"cmd":"goto","url":"..."}
  {"cmd":"dump","tag":"x"}
  {"cmd":"eval","js":"() => (...json-serializable...)","tag":"x"}   # NEVER eval secret values
  {"cmd":"click","text":"..."}
  {"cmd":"fill_label","label":"Host domain","value":"..."}          # by visible label
  {"cmd":"check_label","label":"...","state":true}                  # tick checkbox/radio by label
  {"cmd":"shot","name":"x"}
  {"cmd":"ingest_keys"}       # reads prod Client ID+Secret, pipes to Vercel; values never logged
  {"cmd":"close"}

SECURITY: only ingest_keys touches secret values; it pipes them straight into
`vercel env add`. Values are never printed/logged/screenshotted/returned.
"""
import os, sys, time, json, subprocess
from playwright.sync_api import sync_playwright

PROJECT  = "/Users/torlanpittman/Projects/pitt-stop-internal"
PROFILE  = os.path.join(PROJECT, ".browser-profiles", "intuit-developer")
SHOTS    = os.path.join(PROJECT, ".browser-profiles", "screenshots")
LOG_F    = "/tmp/intuit_driver.log"
CMD_F    = "/tmp/intuit_cmd"
RES_F    = "/tmp/intuit_result"
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
          fields: [...document.querySelectorAll('input,textarea,select')]
             .map(e=>({label:(e.getAttribute('aria-label')||e.placeholder||e.name||''),
                       type:e.type||e.tagName, readonly:e.readOnly||false, empty:!e.value})),
        })""")
        btns = sorted(set(b for b in info['buttons'] if b))
        heads = sorted(set(h for h in info['headings'] if h))
        log(f"[{tag}] url: {page.url}")
        log(f"[{tag}] buttons/tabs: {json.dumps(btns)[:2400]}")
        log(f"[{tag}] headings/labels: {json.dumps(heads)[:2400]}")
        log(f"[{tag}] fields: {json.dumps(info['fields'])[:2600]}")
    except Exception as e:
        log(f"[{tag}] dump err: {e}")

def do_click(page, txt):
    try:
        el = page.locator(f"text={txt}").first
        if el.is_visible(timeout=3000):
            el.click(); page.wait_for_load_state("domcontentloaded"); page.wait_for_timeout(2000)
            return True
    except Exception as e:
        log(f"click err: {e}")
    return False

# React-compatible fill by VISIBLE label text.
FILL_JS = r"""
([labelText, value]) => {
  const norm = s => (s||'').trim().toLowerCase();
  const want = norm(labelText);
  // 1) <label for=id>
  let target = null;
  for (const lab of document.querySelectorAll('label')) {
    if (norm(lab.innerText).startsWith(want) || norm(lab.innerText) === want) {
      const id = lab.getAttribute('for');
      if (id) { const el = document.getElementById(id); if (el) { target = el; break; } }
      // label wrapping input
      const inner = lab.querySelector('input,textarea');
      if (inner) { target = inner; break; }
      // nearest following input in same container
      let cont = lab.closest('div,section,li,tr,form') || lab.parentElement;
      if (cont) { const el = cont.querySelector('input,textarea'); if (el) { target = el; break; } }
    }
  }
  // 2) fallback: any element whose text matches, then following input
  if (!target) {
    const nodes = [...document.querySelectorAll('div,span,p,legend')];
    for (const n of nodes) {
      if (norm(n.innerText) === want) {
        let sib = n.nextElementSibling;
        while (sib) { const el = sib.matches?.('input,textarea') ? sib : sib.querySelector?.('input,textarea'); if (el) { target = el; break; } sib = sib.nextElementSibling; }
        if (target) break;
      }
    }
  }
  if (!target) return {ok:false, reason:'no-target'};
  const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(target, value);
  target.dispatchEvent(new Event('input', {bubbles:true}));
  target.dispatchEvent(new Event('change', {bubbles:true}));
  target.dispatchEvent(new Event('blur', {bubbles:true}));
  return {ok:true, name: target.name||target.id||'', len: value.length};
}
"""

def do_fill_label(page, label, value):
    try:
        r = page.evaluate(FILL_JS, [label, value])
        log(f"fill_label '{label}': {json.dumps(r)}")
        return bool(r.get("ok"))
    except Exception as e:
        log(f"fill_label err: {e}"); return False

CHECK_JS = r"""
([labelText, state]) => {
  const norm = s => (s||'').trim().toLowerCase();
  const want = norm(labelText);
  for (const lab of document.querySelectorAll('label')) {
    if (norm(lab.innerText).includes(want)) {
      let box = null;
      const id = lab.getAttribute('for'); if (id) box = document.getElementById(id);
      if (!box) box = lab.querySelector('input[type=checkbox],input[type=radio]');
      if (!box) { const c = lab.closest('div,li,section'); if (c) box = c.querySelector('input[type=checkbox],input[type=radio]'); }
      if (box) {
        if (box.checked !== state) box.click();
        return {ok:true, checked: box.checked};
      }
    }
  }
  return {ok:false};
}
"""

def do_check(page, label, state):
    try:
        r = page.evaluate(CHECK_JS, [label, bool(state)])
        log(f"check_label '{label}' -> {json.dumps(r)}")
        return bool(r.get("ok"))
    except Exception as e:
        log(f"check err: {e}"); return False

def vercel(args, stdin=None):
    r = subprocess.run(["npx", "vercel", *args, "--scope", SCOPE],
                       input=stdin, capture_output=True, text=True)
    return r.returncode, (r.stdout or "") + (r.stderr or "")

def set_prod_var(name, value):
    vercel(["env", "rm", name, "production", "--yes"])
    code, out = vercel(["env", "add", name, "production"], stdin=value)
    ok = code == 0 or any(k in out.lower() for k in ("added", "created", "success"))
    log(f"  {name}: len={len(value)} -> {'set' if ok else 'FAILED'}")
    if not ok: log(f"    (vercel: {' '.join(out.split()[-12:])[:200]})")
    return ok

def ingest_keys(page):
    data = page.evaluate("""() => {
      const norm = s => (s||'').toLowerCase();
      function labelFor(inp){
        let l = inp.getAttribute('aria-label')||inp.name||inp.placeholder||'';
        if(!l){ const p=inp.closest('div,section,li,tr,form'); const lab=p&&p.querySelector('label'); if(lab) l=lab.innerText; }
        return l;
      }
      // nearest visible text label to the left/above
      function near(inp){
        let p=inp.closest('div,section,li,tr,form'); let t='';
        if(p){ const lab=p.querySelector('label'); if(lab) t=lab.innerText; }
        return t;
      }
      return [...document.querySelectorAll('input,textarea')].map(inp=>({label:labelFor(inp), near:near(inp), val:inp.value||''}));
    }""")
    def norm(s): return (s or "").lower()
    cid = sec = None
    for f in data:
        lab = norm(f["label"]) + " " + norm(f["near"])
        v = f["val"]
        if v and len(v) >= 20:
            if ("client id" in lab or "clientid" in lab) and cid is None: cid = v
            elif "secret" in lab and sec is None: sec = v
    log(f"ingest: id={'yes' if cid else 'no'} secret={'yes' if sec else 'no'}")
    if not cid or not sec or cid == sec:
        inv = [{"label": f["label"], "near": f["near"], "len": len(f["val"])} for f in data if f["val"]]
        log("ingest candidates(no values): " + json.dumps(inv)[:1600])
        result("INGEST_AMBIGUOUS"); return
    log("ingest: writing to Vercel production…")
    a = set_prod_var("QUICKBOOKS_CLIENT_ID", cid)
    b = set_prod_var("QUICKBOOKS_CLIENT_SECRET", sec)
    cid = sec = None
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
        log("DRIVER2_READY url=" + page.url)
        log("LOGIN_STATE=" + ("in" if logged_in(ctx) else "out"))
        result("READY")

        deadline = time.time() + 5400  # 90 min
        while time.time() < deadline:
            if not os.path.exists(CMD_F):
                time.sleep(1.2); continue
            try: cmd = json.loads(open(CMD_F).read() or "{}")
            except Exception as e: cmd = {}; log(f"cmd parse err: {e}")
            try: os.remove(CMD_F)
            except OSError: pass
            pg = active_page(ctx) or page
            c = cmd.get("cmd")
            log(f"--- CMD: {json.dumps(cmd)[:200]}")
            if c == "close":
                result("CLOSED"); break
            elif c == "status":
                log("URLS=" + json.dumps([p.url for p in ctx.pages]))
                result("in" if logged_in(ctx) else "out")
            elif c == "goto":
                try:
                    pg.goto(cmd["url"], wait_until="domcontentloaded", timeout=45000)
                    pg.wait_for_timeout(2500); log("now: " + pg.url); result("GOTO_DONE")
                except Exception as e: log(f"goto err: {e}"); result("GOTO_ERR")
            elif c == "dump":
                dump(pg, cmd.get("tag", "dump")); result("DUMP_DONE")
            elif c == "eval":
                try:
                    r = pg.evaluate(cmd["js"])
                    log(f"[{cmd.get('tag','eval')}] " + json.dumps(r)[:2600]); result("EVAL_DONE")
                except Exception as e:
                    log(f"eval err: {e}"); result("EVAL_ERR")
            elif c == "click":
                ok = do_click(pg, cmd["text"]); log("after click: " + pg.url); result("CLICK_" + ("OK" if ok else "MISS"))
            elif c == "fill_label":
                ok = do_fill_label(pg, cmd["label"], cmd["value"]); result("FILL_" + ("OK" if ok else "MISS"))
            elif c == "check_label":
                ok = do_check(pg, cmd["label"], cmd.get("state", True)); result("CHECK_" + ("OK" if ok else "MISS"))
            elif c == "shot":
                try:
                    pth = os.path.join(SHOTS, cmd.get("name", "shot") + ".png")
                    pg.screenshot(path=pth, full_page=cmd.get("full", False)); log("shot: " + pth); result("SHOT_DONE")
                except Exception as e: log(f"shot err: {e}"); result("SHOT_ERR")
            elif c == "ingest_keys":
                ingest_keys(pg)
            else:
                log("unknown cmd"); result("UNKNOWN")
        ctx.close(); log("DRIVER2_EXIT")

if __name__ == "__main__":
    main()
