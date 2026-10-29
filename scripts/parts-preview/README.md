# Parts screenshot-import — local preview harness

A **non-production, synthetic** preview of the Parts screenshot-import UI. It renders the **actual**
`PartImportPanel` component with an in-memory fixture transport — **no database, network, PartsTech, or
OpenAI**, and **no production auth bypass**. Everything shown is clearly-labeled sample data.

## What it shows
EQUAL PERMISSIONS — the import workflow is identical for every authorized shop user, so there is ONE shared
job screen (no employee/manager split). A simple **screen selector** renders ONE real component at a time:
- **Parts page** — the actual shared `PartsLanding` (Open PartsTech + guidance; nav is injected to stay in
  the sample).
- **Job parts** — a scenario selector: **Placed order / Quote (no cost) / Failed read / Reading… /
  Cancelled.** Review descriptions / numbers / quantities / **purchase costs**, per-row **New / Link / Skip**,
  link a row to the existing sample part (its saved cost is shown), the **“I placed this order”** toggle,
  warnings, the **original source PNG**, and **Review & save parts to job**. Everyone sees costs and originals.

The original screenshots are the **actual** synthetic PNGs in `assets/` (`sample-order.png`, `sample-quote.png`),
served by a **dev-only** route (`/parts/preview/sample/order|quote`, fixed allowlist, production 404) so the
extracted rows can be compared to the image. The fixture rows match the images: Brake pad set / DEMO-PAD-01,
Brake rotor / DEMO-ROT-02, Alternator / DEMO-ALT-03.

## How to view it (Codex runs this; do not run it from the Claude session)
```
npm run dev
```
then open: **http://localhost:3000/parts/preview**

Both the preview page and the sample-image route are **hard-gated** off in production (`NODE_ENV` check), so
they can never mount on the live app. No extra dependencies; no auth/network bypass for real routes.

## Files
- `fixtures.ts` — synthetic job + per-scenario proposal + the in-memory `ImportTransport` state machine
  (upload → read → review → apply/cancel). **Live AI extraction is NOT exercised** — “read” returns fixed rows.
- `assets/sample-order.png`, `assets/sample-quote.png` — the synthetic source screenshots (copied by the
  coordinator; no real data/secrets).
- `app/parts/preview/page.tsx` + `PartsPreview.tsx` — the guarded route + client harness.
- `app/parts/preview/sample/[name]/route.ts` — the dev-only, allowlisted sample-image server.

## Not covered by the preview
Real auth gating, the private Blob storage, the AI reader, the atomic SQL apply, and the DB idempotency
guards are exercised by the Vitest suites (`apps/parts/*.test.ts` with PGlite + mocked OpenAI, and the route
`*.test.ts` files for the shared gate, equal-permission review/apply, and private image retrieval), not here.
