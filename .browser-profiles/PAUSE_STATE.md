# Investigation Pause State — 2026-07-27

## What was collected (confirmed on disk)

| File | Status | Notes |
|------|--------|-------|
| `screenshots/01_al_qb_settings.png` | ✅ Captured | AutoLeap QB integration settings page |
| `screenshots/04_qbo_audit_log.png` | ⚠️ Captured but suspect | All QBO shots are 70752 bytes — may be login/blank page |
| `screenshots/05_qbo_sales_settings.png` | ⚠️ Same size concern | |
| `screenshots/06_qbo_advanced_settings.png` | ⚠️ Same size concern | |
| `screenshots/07_qbo_connected_apps.png` | ⚠️ Same size concern | |
| `findings.json` | ❌ Errors only | Both autoleap and qbo investigations errored |

## Confirmed findings from earlier (manual osascript inspection)

From the live AutoLeap session in the user's regular Chrome, before switching to Playwright:

- **Connection Status**: Connected
- **QuickBooks Company**: Pitt Stop Detail & Auto Sales
- **QuickBooks Country**: US
- **QuickBooks Version**: 47
- **Account settings last updated**: Oct 30, 2024 9:16 AM
- **Auto-sync to QBO on invoicing**: **OFF** (checkbox checked=false, data-checked=false)
- **Product mappings** (all configured):
  - Parts → "Parts"
  - Labor → "Labor"
  - Tire → "Tire"
  - Tire storage → "Tire Storage"
  - Sublet → "Sublet"
  - Others → "Other"
  - Fees → "Fees"
  - Discount → "Discount"
  - Credit memo → "Credit Memo"

## What still needs investigation

1. QBO Audit Log — need to see actual log entries with "Modified by" app name and action type
2. QBO Account Settings → Sales → "Custom transaction numbers" ON or OFF?
3. QBO Connected Apps — what apps are connected and their permissions
4. QBO Invoice list — find the affected invoices, confirm their state
5. AutoLeap Reports — look for any sync history or export log
6. AutoLeap: with auto-sync OFF, how are invoices being synced? Manual button per invoice?

## Root cause hypothesis (unchanged, confidence ~80%)

AutoLeap changed duplicate-handling from "fail and warn" to "find existing invoice by DocNumber → UPDATE it by Id". Auto-sync is currently OFF (possibly turned off after the problem was noticed, or it was always off and there's a per-invoice sync button).

## How to resume

1. Open terminal in this project directory
2. Run: `python3 .browser-profiles/investigate.py`
3. Log into QBO and AutoLeap in the Playwright Chromium window that opens
4. Tell Claude "I'm logged in"
5. Claude will send the READY signal

## Known script issues to fix before next run

- AutoLeap timeout: the load timeout hits because AutoLeap's Angular app routes lazily
  Fix: use `wait_until="domcontentloaded"` + explicit `wait_for_selector(".tertiary-nav-item")`
- QBO pages: `networkidle` times out; `/app/invoices` also times out
  Fix: use `wait_until="domcontentloaded"` throughout and wait for specific elements
- AutoLeap auto-sync selector: already fixed in script (uses `input[id=...]`)
- READY cleanup: script deletes READY at startup; pre-seeding doesn't work
  Fix: remove the cleanup-at-startup step
