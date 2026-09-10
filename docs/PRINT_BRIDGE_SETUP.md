# Pitt Stop Print Bridge — Setup

The **print bridge** is the permanent, always-on link between Pitt Stop OS (cloud) and the shop's
**Brother HL-L2420DW**. Managers write + record a check from their phone; the check is placed on a
secure cloud **print queue**; the bridge on the always-on **shop laptop** pulls the job and prints it.

```
Torlan / Darryl / Tony phone  →  Pitt Stop OS (Vercel)  →  print queue (DB)
                                                              ↓  (pull, token-authenticated)
                                          shop laptop running scripts/print-bridge.mjs
                                                              ↓  lp (macOS)  /  SumatraPDF (Windows)
                                                        Brother HL-L2420DW  →  physical check
```

**No phone needs the Brother installed.** The bridge is a dumb, authenticated poller: it only receives
already-rendered check PDFs, prints them, and reports status. It runs unattended, restarts on reboot,
survives internet/printer outages (jobs wait in the queue), and never prints duplicates (the server
hands each job to exactly one bridge).

The MacBook can run this **same** agent today as a temporary bridge; moving to the shop laptop later
requires **no code changes** — just run the script there instead.

---

## 1. One-time server config (Vercel)

Set a strong shared secret (only the server + the bridge know it):

```
PRINT_BRIDGE_TOKEN = <64 random hex chars>     # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add it in Vercel → Project → Settings → Environment Variables (Production), then redeploy. If this is
unset, **every** bridge call is rejected (fail closed) — no unauthenticated print endpoint exists.

The bank accounts, category→expense mapping, starting check number, and print calibration are set in the
app at **/admin/checks** (owner, behind ADMIN_PASSWORD). The feature ships **off** until enabled there.

---

## 2. Identify the printer name on the shop laptop

- **macOS:** `lpstat -p` → e.g. `Brother_HL_L2420DW`
- **Windows:** PowerShell `Get-Printer | Select Name` → e.g. `Brother HL-L2420DW`

Use USB or the shop network — either is fine, as long as the laptop can print to it.

---

## 3. Install the bridge on the shop laptop

1. Install **Node.js LTS** (https://nodejs.org).
2. Copy the repo's `scripts/print-bridge.mjs` onto the laptop (e.g. `C:\pittstop\print-bridge.mjs` or
   `~/pittstop/print-bridge.mjs`).
3. Next to it create **`print-bridge.config.json`**:

```json
{
  "PITTSTOP_BASE_URL": "https://YOUR-pitt-stop-os.vercel.app",
  "PRINT_BRIDGE_TOKEN": "the-same-64-hex-token-as-vercel",
  "PRINTER_NAME": "Brother_HL_L2420DW",
  "BRIDGE_ID": "shop-laptop"
}
```

4. Smoke test (leave it running): `node print-bridge.mjs` → it logs `print bridge starting …` and polls.
   Then from a phone, write + record a check and tap **Send to Shop Printer** — it should print and the
   phone should show **printed ✓**.

### macOS: print command + auto-start

- Printing uses the built-in `lp` — nothing to install.
- Auto-start with a LaunchAgent so it runs after login/reboot and restarts if it ever exits. Create
  `~/Library/LaunchAgents/com.pittstop.printbridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pittstop.printbridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>            <!-- `which node` -->
    <string>/Users/SHOPUSER/pittstop/print-bridge.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/pittstop-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/pittstop-bridge.err</string>
</dict></plist>
```

Then: `launchctl load ~/Library/LaunchAgents/com.pittstop.printbridge.plist`. Keep the laptop logged in
(System Settings → Users → enable automatic login; and disable sleep while on power).

### Windows: print command + auto-start

- Install **SumatraPDF** (free, silent printing) from https://www.sumatrapdfreader.org. Default path
  `C:\Program Files\SumatraPDF\SumatraPDF.exe` is auto-detected; otherwise add
  `"SUMATRA_PATH": "C:\\path\\to\\SumatraPDF.exe"` to the config.
- Auto-start with **Task Scheduler**: Create Task → *Run whether user is logged on or not* (or *At log
  on*) → Trigger **At log on** → Action **Start a program** → Program `node`, Arguments
  `C:\pittstop\print-bridge.mjs`, Start in `C:\pittstop`. Check *If the task fails, restart every 1
  minute*. Keep the laptop signed in and set Power to never sleep.

---

## 4. Operating notes

- **Outage-safe:** if internet or the printer is down, jobs stay `queued` and print when the bridge is
  back. The agent loops forever and never crashes on transient errors.
- **No duplicates:** each job is claimed atomically (skip-locked) so only one bridge prints it. If a
  print *fails*, the phone shows "failed — resend"; resending enqueues a fresh job (same check #, same
  QuickBooks transaction — never a new expense).
- **Reprint:** the Reprint button re-queues the exact same check; it never creates a new QuickBooks
  transaction or a new check number.
- **Security:** the bridge only ever receives rendered check PDFs. No bank credentials, QuickBooks
  tokens, or account numbers pass through it. The bearer token is the only key.
