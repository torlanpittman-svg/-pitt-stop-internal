# Customer import inbox

Drop AutoLeap / QuickBooks customer exports here. **Contents are git-ignored** (PII —
never committed) except this README and `.gitignore`.

## AutoLeap Customer CSV

1. In your **normal browser** (Safari/Chrome): app.myautoleap.com → **Reports → Customer**
   → **Export**.
2. Move/save the downloaded CSV into this folder (`data/imports/`).
3. Dry-run (writes nothing):

   ```
   node scripts/import-autoleap-customers.mjs
   ```

   (Auto-picks the newest `.csv` here. Or pass a path.)

4. Review the printed report + `data/imports/reports/import-*.json`.
5. When it looks right, apply:

   ```
   node scripts/import-autoleap-customers.mjs --commit
   ```

## Other commands

- `--list-batches` — recent import runs
- `--rollback <batchId>` — undo a committed batch (removes the rows it created)
- `--limit <N>` — process only the first N rows (testing)
- `--file <path>` — explicit CSV path

The importer only writes to the directory tables (`customers`, `customer_vehicles`,
`possible_matches`, `customer_import_batches`). It never touches Quick Entry jobs,
AutoLeap, or QuickBooks. Re-running the same file is safe (idempotent).
