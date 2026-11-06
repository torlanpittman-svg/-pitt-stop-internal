# Appointment check-in: which vehicle, and where the VIN comes from (2026-11-06)

**Trigger:** PS-HJY66R (Charles Booker Jr, 2025 GMC Sierra HD) checked in 2026-11-06 → SO-20261106-0001
with year/make/model but no VIN.

## Verified cause (production read-only, host `ep-morning-base-adq5h6rq`, deployed commit 3b54ebb)
- The customer row (`5c952e0a…`) is the **AutoLeap import** (2026-08-08). The AutoLeap export carried only
  `No. of vehicles: 2` — no vehicle rows were ever imported (every `customer_vehicles` row in production is
  `source='quick_entry'`). Before check-in this customer had **zero** vehicles on file, and no vehicle, estimate
  or job anywhere in the database carries a 2025 GMC Sierra HD VIN.
- The public booking form collects type/year/make/model only (no VIN field, no saved-vehicle picker). Both of
  his bookings (PS-YZTXJV 2026-10-23, never checked in; PS-HJY66R 2026-11-04) have `vehicle_vin = NULL`.
- Check-in therefore found nothing to reuse and `findOrCreateVehicle` created vehicle `6dffb442…` at
  13:19:26.346Z (30 ms before the order) with `vin = NULL`.
- **Verdict: the VIN is absent — it was never captured anywhere. Nothing was wrong-linked and nothing was dropped.**
  The only correction is operational: scan the VIN on the Job (Job detail → Edit Vehicle / Scan VIN).

## Real gaps found on the way (fixed on `fix/appointment-vehicle-vin`, not deployed)
1. **Reused saved vehicle lost its VIN on the intake record.** `createQuickEntryJob({ vehicleId })` wrote
   `quick_entry_jobs.vin/final_vin/year/make/model/color` from the typed booking text instead of the reused
   row. Seen on PS-25BG56: vehicle VIN `1FTFW7L80TFA12752`, intake record NULL. Now the reused row describes
   the Job's vehicle; typed text only fills blanks; the vehicle row itself is never overwritten.
2. **Silent duplicate when the saved vehicle did not match exactly.** `matchCustomerVehicle` reused a saved
   vehicle only on an exact single year/make/model match; with two matches, or a naming difference
   (e.g. VIN-decoded "Sierra 2500HD" vs the booking's NHTSA "Sierra HD"), it silently created a new
   VIN-less vehicle. Now `resolveCheckinVehicle`:
   - honours a vehicle staff chose (must be on this customer's file) or an explicit "new vehicle";
   - a staff-entered VIN on the appointment still de-dupes by VIN;
   - nothing on file → new row, no VIN (the Booker case; never inferred);
   - exactly one saved match → reused;
   - otherwise **refuses before claiming the appointment** until staff choose.
   The appointment screen now lists the customer's saved vehicles (with VINs) and a "New vehicle" option;
   the choice is recorded on the `checked_in` event (`vehicle: linked|chosen|new|vin|none_on_file|matched`).

## Verification
- `npx vitest run apps/appointments apps/quick-entry app/appointments` → 24 files / 414 tests pass.
- New coverage: `apps/appointments/checkin-notify.integration.test.ts` ("which vehicle" block, 6 cases) and
  `apps/quick-entry/saved-vehicle-vin.test.ts` (3 cases). 8 of the 9 fail on the pre-fix code.
- `tsc --noEmit` clean for the changed files (the only errors are pre-existing in `apps/estimates/quickbooks.test.ts`).
- No migration, no flag, no QuickBooks/email path touched. Nothing deployed; no production data changed.
