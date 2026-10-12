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

- **Bridge status:** every poll is a heartbeat. The check screens show "Shop printer link: online /
  OFFLINE — last seen …". The heartbeat also records when the bridge process started, so a reboot is
  visible (new start time, back online without anyone touching it).
- **Outage-safe, without late prints:** if internet or the printer is down, a job waits `queued` for up
  to 10 minutes, then **expires** — it never prints by surprise hours later. Send it again when ready.
- **No duplicates:** each job is claimed atomically by one bridge, and a check can have only one open
  print job at a time. While a job is open the app offers no way to send the check again.
- **"Sent" is not "printed":** the bridge reports only that the printer accepted the job (on Windows it
  waits for the job to leave the print spooler; a job the printer never takes is cancelled and reported
  failed). A manager then confirms in the app that the paper came out. If it did not, the check stays held
  until the original is cleared (Windows print queue emptied + printer power-cycled) — only then can it be
  sent again, so a job waiting in an offline printer can never become a second check.
- **Reprint:** offered only after a confirmed print, and requires ticking that the original was destroyed
  or never left the shop. Same check number, same QuickBooks transaction — never a new expense.
- **No check PDFs left on disk:** each PDF is deleted right after printing, and any leftovers are removed
  when the bridge starts.
- **Security:** the bridge only ever receives rendered check PDFs. No QuickBooks tokens pass through it.
  The bearer token is the only key.
- **Updating the bridge (Windows):** build the one-file updater with
  `node scripts/build-bridge-update.mjs PittStop-Bridge-Update-R2.cmd`, get it onto the laptop, and
  double-click it. The shop laptop does not run `node` directly from the task: the task runs
  `wscript start-bridge.vbs`, which starts a hidden `cmd /c start-bridge.bat` loop that relaunches
  `node print-bridge.mjs` 5 seconds after it exits. The updater therefore stops that loop and the bridge
  together, replaces only `print-bridge.mjs` (keeping a backup), removes leftover temporary check PDFs,
  starts exactly one bridge through the existing task, checks the bridge's log for the new version and
  "connected", and rolls back if that fails. By hand: end the hidden `cmd.exe` running
  `start-bridge.bat` *first*, then `node.exe`, replace the file, and run the task once.
  An older bridge keeps working against the new server (its "success" is treated as "sent — awaiting
  confirmation"), but reports no version or start time and has no spooler watch or PDF cleanup.
