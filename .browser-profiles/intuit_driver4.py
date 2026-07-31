"""
Persistent, file-controlled Intuit Developer driver (v3) — tab-aware.

Adds multi-tab targeting so the Compliance "App assessment questionnaire"
(which opens in a separate help.developer.intuit.com tab) can be driven.

Control: write JSON to /tmp/intuit_cmd; summary -> /tmp/intuit_result; verbose
-> /tmp/intuit_driver.log.

New/changed commands:
  {"cmd":"pages"}                       -> list all tab urls with index
  {"cmd":"focus","substr":"questionnaire"} -> prefer the tab whose url contains substr
  {"cmd":"close_tab","substr":"..."}    -> close tabs whose url contains substr
Existing:
  status | goto | dump | eval | click | fill_label | check_label | shot | ingest_keys | close

SECURITY: only ingest_keys touches secret values; piped to `vercel env add`,
never printed/logged/screenshotted/returned.
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

PREFERRED = {"substr": None}  # mutable focus target

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
    pages = ctx.pages
    sub = PREFERRED["substr"]
    if sub:
        matches = [p for p in pages if sub in p.url]
        if matches:
            return matches[-1]
    ins = [p for p in pages if is_in(p.url)]
    if ins:
        return ins[-1]
    return pages[-1] if pages else None

def dump(page, tag="dump"):
    try:
        info = page.evaluate("""() => ({
          buttons: [...document.querySelectorAll('button,a,[role=tab],[role=button]')]
             .map(e=>e.innerText.trim()).filter(t=>t&&t.length<60),
          headings: [...document.querySelectorAll('h1,h2,h3,h4,legend,label,[role=heading],p')]
             .map(e=>e.innerText.trim()).filter(t=>t&&t.length<160),
          fields: [...document.querySelectorAll('input,textarea,select')]
             .map(e=>({label:(e.getAttribute('aria-label')||e.placeholder||e.name||''),
                       type:e.type||e.tagName})),
        })""")
        btns = sorted(set(b for b in info['buttons'] if b))
        heads = sorted(set(h for h in info['headings'] if h))
        log(f"[{tag}] url: {page.url}")
        log(f"[{tag}] buttons: {json.dumps(btns)[:2200]}")
        log(f"[{tag}] text: {json.dumps(heads)[:3000]}")
        log(f"[{tag}] fields: {json.dumps(info['fields'])[:2200]}")
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

FILL_JS = r"""
([labelText, value]) => {
  const norm = s => (s||'').trim().toLowerCase();
  const want = norm(labelText);
  let target = null;
  for (const lab of document.querySelectorAll('label')) {
    if (norm(lab.innerText).startsWith(want) || norm(lab.innerText) === want) {
      const id = lab.getAttribute('for');
      if (id) { const el = document.getElementById(id); if (el) { target = el; break; } }
      const inner = lab.querySelector('input,textarea');
      if (inner) { target = inner; break; }
      let cont = lab.closest('div,section,li,tr,form') || lab.parentElement;
      if (cont) { const el = cont.querySelector('input,textarea'); if (el) { target = el; break; } }
    }
  }
  if (!target) return {ok:false};
  const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(target, value);
  target.dispatchEvent(new Event('input', {bubbles:true}));
  target.dispatchEvent(new Event('change', {bubbles:true}));
  target.dispatchEvent(new Event('blur', {bubbles:true}));
  return {ok:true};
}
"""

def do_fill_label(page, label, value):
    try:
        r = page.evaluate(FILL_JS, [label, value]); log(f"fill '{label}': {json.dumps(r)}"); return bool(r.get("ok"))
    except Exception as e:
        log(f"fill err: {e}"); return False

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
      if (box) { if (box.checked !== state) box.click(); return {ok:true, checked: box.checked}; }
    }
  }
  return {ok:false};
}
"""

def do_check(page, label, state):
    try:
        r = page.evaluate(CHECK_JS, [label, bool(state)]); log(f"check '{label}' -> {json.dumps(r)}"); return bool(r.get("ok"))
    except Exception as e:
        log(f"check err: {e}"); return False

def vercel(args, stdin=None):
    r = subprocess.run(["npx", "vercel", *args, "--scope", SCOPE], input=stdin, capture_output=True, text=True)
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
      function labelFor(inp){ let l=inp.getAttribute('aria-label')||inp.name||inp.placeholder||''; if(!l){const p=inp.closest('div,section,li,tr,form'); const lab=p&&p.querySelector('label'); if(lab) l=lab.innerText;} return l; }
      function near(inp){ let p=inp.closest('div,section,li,tr,form'); let t=''; if(p){const lab=p.querySelector('label'); if(lab) t=lab.innerText;} return t; }
      return [...document.querySelectorAll('input,textarea')].map(inp=>({label:labelFor(inp), near:near(inp), val:inp.value||''}));
    }""")
    def norm(s): return (s or "").lower()
    cid = sec = None
    for f in data:
        lab = norm(f["label"]) + " " + norm(f["near"]); v = f["val"]
        if v and len(v) >= 20:
            if ("client id" in lab or "clientid" in lab) and cid is None: cid = v
            elif "secret" in lab and sec is None: sec = v
    log(f"ingest: id={'yes' if cid else 'no'} secret={'yes' if sec else 'no'}")
    if not cid or not sec or cid == sec:
        inv = [{"label": f["label"], "near": f["near"], "len": len(f["val"])} for f in data if f["val"]]
        log("ingest candidates(no values): " + json.dumps(inv)[:1600]); result("INGEST_AMBIGUOUS"); return
    a = set_prod_var("QUICKBOOKS_CLIENT_ID", cid); b = set_prod_var("QUICKBOOKS_CLIENT_SECRET", sec)
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
            page.goto("https://developer.intuit.com/app/developer/myapps", wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            log(f"goto err: {e}")
        page.wait_for_timeout(3000)
        log("DRIVER4_READY url=" + page.url); log("LOGIN_STATE=" + ("in" if logged_in(ctx) else "out")); result("READY")

        deadline = time.time() + 7200  # 2h
        while time.time() < deadline:
            if not os.path.exists(CMD_F):
                time.sleep(1.2); continue
            try: cmd = json.loads(open(CMD_F).read() or "{}")
            except Exception as e: cmd = {}; log(f"cmd parse err: {e}")
            try: os.remove(CMD_F)
            except OSError: pass
            c = cmd.get("cmd")
            pg = active_page(ctx) or page
            log(f"--- CMD: {json.dumps(cmd)[:200]} (active={pg.url[:70] if pg else 'none'})")
            if c == "close":
                result("CLOSED"); break
            elif c == "pages":
                for i, p in enumerate(ctx.pages): log(f"  [{i}] {p.url}")
                result("PAGES_DONE")
            elif c == "focus":
                PREFERRED["substr"] = cmd.get("substr"); log("focus set: " + str(PREFERRED["substr"])); result("FOCUS_SET")
            elif c == "close_tab":
                sub = cmd.get("substr", ""); n = 0
                for p in list(ctx.pages):
                    if sub and sub in p.url:
                        try: p.close(); n += 1
                        except Exception as e: log(f"close_tab err: {e}")
                log(f"closed {n} tab(s)"); result("CLOSETAB_DONE")
            elif c == "status":
                log("URLS=" + json.dumps([p.url for p in ctx.pages])); result("in" if logged_in(ctx) else "out")
            elif c == "goto":
                try:
                    pg.goto(cmd["url"], wait_until="domcontentloaded", timeout=45000); pg.wait_for_timeout(2500); log("now: " + pg.url); result("GOTO_DONE")
                except Exception as e: log(f"goto err: {e}"); result("GOTO_ERR")
            elif c == "dump":
                dump(pg, cmd.get("tag", "dump")); result("DUMP_DONE")
            elif c == "eval":
                try: r = pg.evaluate(cmd["js"]); log(f"[{cmd.get('tag','eval')}] " + json.dumps(r)[:3000]); result("EVAL_DONE")
                except Exception as e: log(f"eval err: {e}"); result("EVAL_ERR")
            elif c == "click":
                ok = do_click(pg, cmd["text"]); log("after click: " + pg.url); result("CLICK_" + ("OK" if ok else "MISS"))
            elif c == "fill_label":
                ok = do_fill_label(pg, cmd["label"], cmd["value"]); result("FILL_" + ("OK" if ok else "MISS"))
            elif c == "check_label":
                ok = do_check(pg, cmd["label"], cmd.get("state", True)); result("CHECK_" + ("OK" if ok else "MISS"))
            elif c == "shot":
                try:
                    pth = os.path.join(SHOTS, cmd.get("name", "shot") + ".png"); pg.screenshot(path=pth, full_page=cmd.get("full", False)); log("shot: " + pth); result("SHOT_DONE")
                except Exception as e: log(f"shot err: {e}"); result("SHOT_ERR")
            elif c == "ingest_keys":
                ingest_keys(pg)
            elif c == "pclick":
                try:
                    pg.locator(cmd["selector"]).first.click(timeout=8000); pg.wait_for_timeout(300); result("PCLICK_OK")
                except Exception as e:
                    log(f"pclick err: {e}"); result("PCLICK_ERR")
            elif c == "pkey":
                try:
                    pg.keyboard.press(cmd["keys"]); pg.wait_for_timeout(150); result("PKEY_OK")
                except Exception as e:
                    log(f"pkey err: {e}"); result("PKEY_ERR")
            elif c == "ptype":
                try:
                    pg.keyboard.type(cmd["text"], delay=cmd.get("delay", 6)); pg.wait_for_timeout(300); result("PTYPE_OK")
                except Exception as e:
                    log(f"ptype err: {e}"); result("PTYPE_ERR")
            else:
                log("unknown cmd"); result("UNKNOWN")
        ctx.close(); log("DRIVER4_EXIT")

if __name__ == "__main__":
    main()
