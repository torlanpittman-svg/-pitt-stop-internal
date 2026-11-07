# Restoration release progress — 2026-11-07 (release completed; final checks recorded)

**This file is the live state of the release and supersedes the "not done / held" checklists in the other docs
in this folder.** All external operations below were performed and independently verified by Codex under the
owner's standing approval. Nothing here is a claim about ad approval, serving, search ranking or revenue.

## Owner approvals in force (do not re-ask)
Production release approved. **$600/month for the THREE NEW campaigns only** — existing campaigns/budgets
untouched. Third-party glass partner wording; insurer decides coverage; no labor-cost input required
(profitability reported as UNMEASURED); generated, visibly-labelled illustrations allowed. **No renewed budget
approval is needed to enable the three campaigns.**

## 1. Application — DEPLOYED ✅
- Production = application source SHA `0d35d6e29e379550733f791b89c4b246e6039b7c`, Vercel **READY** (verified via the Vercel API).
- Migration **0076 applied and verified** on the production endpoint (2026-11-07T21:37:50Z): five additive
  columns + one partial index; no customer records touched; the local write guard unchanged.
- Final full suite **253 files / 3,271 tests passed**; focused landing-page suite **69 tests passed**; `next build --webpack` passed; release-source ESLint clean.
  The 10 standalone `tsc` errors in `apps/estimates/quickbooks.test.ts` are pre-existing fixture errors,
  unchanged (Next production typechecking passed).

## 2. WordPress — FIVE PAGES PUBLISHED ✅
| Page ID | Slug |
|---|---|
| 7630 | `/insurance-auto-repair/` (hub) |
| 7632 | `/car-vandalism-repair/` |
| 7634 | `/car-overspray-removal/` |
| 7636 | `/car-water-damage/` |
| 7638 | `/auto-glass-repair/` |

- Canonical, meta, single H1, internal links and images checked on each published page.
- Four generated illustrations = media **7626–7629**, each visibly captioned
  “Illustrative image — not a completed Pitt Stop job.” Public URLs recorded in `assets.json`.
- Footer **Menu 2** now carries an “Insurance Restoration” item (**7643**, position 5).
- Search Console: indexing **requests accepted for all five** — do NOT claim indexed or ranked.
- Final live correction: WordPress entity-encoded `&&`, breaking the attribution script. The renderer now emits
  no literal ampersands, and all five pages were rebuilt and republished. Theme header/mobile booking links now
  lead to the correct estimate service (hub = Choose Damage Type). The old booking marker is removed so an
  estimate click does not trigger the theme's appointment-click event.
- Live DOM checks on ALL FIVE published pages confirmed gclid/UTM preservation, correct service/landing-page
  values, corrected header/sticky/mobile-bar links, one H1, and no overflow at 1280 px. Organic hub defaults also
  verified. The public hub was visually checked at 390×844 before this link-only correction; the viewport tool
  subsequently stayed at 1280 px, so final 390 px visual verification of all five pages is NOT claimed.
- Source correction commit `0d35d6e`; Vercel deployment `dpl_A5FdXGcC65GxsgATJWAFd1Q1nFp2` is READY with all
  production aliases, verified against the exact SHA through the Vercel API. No second test inquiry was submitted.

## 3. Live test inquiry — ONE, DONE, CLOSED ✅
Exactly ONE owner-authorized, clearly-labelled TEST inquiry was submitted:
lead `4a348077-7f70-4372-bdc4-1f555981499b`, one DB row, `email_status=sent`, `email_attempts=1`,
GA4 `quote_requested` count 1, UTM `release_check/qa` + the vandalism landing page captured.
No appointment, invoice or repair was created. **No further live test inquiries are authorized — never repeat.**

## 4. Google Ads (account 684-374-8548) — THREE CAMPAIGNS ENABLED ✅
- All FIVE CSV imports **applied**, each after a zero-error preview: 3 campaigns, 6 ad groups, 34 keywords,
  157 negatives, 6 RSAs. **All three campaigns ENABLED** on 2026-11-07; Google Ads confirmed “3 campaigns
  enabled” and each row shows **Eligible (Learning)**. At verification all three showed 0 impressions, clicks and
  cost; this is launch-state evidence, not a claim that ads have served or will remain at zero spend.
- Campaign IDs: vandalism **24449757985** · overspray **24443961749** · water **24449757004**.
- Budgets: **$9.00 / $6.00 / $4.70 per day = $19.70/day = $598.88 per 30.4-day month** (within the ceiling).
- Conversion goals: all three campaigns use campaign-specific **“Request quotes” goals ONLY**. `quote_requested`
  = conversion **7893957510**, **Primary**, no monetary value, NOT the account default. GA4↔Ads counting
  “First” verified (only one conversion saved via the GA4/Ads conversion editor). Existing global booking/call
  goals unchanged.
- Settings (saved, then reopened and re-verified per campaign): Search only; Search partners + Display
  unchecked; AI Max off; broad match off; automatic assets / text customization / final-URL expansion off.
  Locations = Bryan + College Station, **Presence only**. Ad schedule Mon–Sat 06:00–22:00 Central, six rows per
  campaign, no Sunday. Auto-tagging ON. Campaign-specific UTM suffixes verified.
- **Language targeting:** Google removed manual Search language targeting in Sep 2026 — the UI shows “—”;
  English copy/keywords rely on automatic language matching. Refs:
  https://support.google.com/google-ads/answer/1722078?hl=en-KY ·
  https://ads-developers.googleblog.com/2026/08/google-ads-language-targeting-changes.html?m=0
  The old “Language: English” launch gate is obsolete — do not re-add it.
- Assets: the existing GBP account location is enabled (3112 Texas Avenue South, College Station). NEW call
  asset **(979) 696-6640** attached to all 3 (Mon–Fri 07:00–18:00, Sat 08:00–14:00) — **Pending / Under
  review**; the original account-level phone asset is unchanged. NEW five sitelinks attached to all 3:
  Vandalism Repair, Overspray Removal, Water Damage Assessment, Auto Glass Assistance (description “Glass
  service through our partner”), Insurance Restoration hub — URLs = the five public pages; the existing account
  “Contact Us” sitelink is inherited. NEW callouts on all 3: Itemized Estimates, Photos Welcome, College
  Station Shop (all ≤25 chars). **All new assets Under review** — do not claim approved.
- Ad text: the six `Call (979) 696-6640` headlines were replaced with `Get Your Written Estimate` (25 chars) —
  Google policy prohibits phone numbers in ad text (https://support.google.com/adspolicy/answer/14848200); the
  call asset is the phone path. `ads/ads_rsa.csv` now carries an explicit `Ad type = Responsive search ad`
  column matching the successful web upload. All 6 rows meet the ≤30-char headline / ≤90-char description limits.

## 5. Spend → report mapping — SAVED AND RELEASED; LIVE DISPLAY CHECK PENDING ⏳
`GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON` was saved in Vercel Production before the new deployment:
`{"24449757985":"restoration","24443961749":"restoration","24449757004":"restoration"}`.
The normal GitHub → Vercel deployment of `0d35d6e` completed READY after this setting was saved. The earlier
manual redeploy and identity-code prompt were cancelled; that code request is obsolete. No authentication
protection was changed. **Live spend retrieval/display is not independently verified yet**: the correct internal
report URL `https://pitt-stop-internal.vercel.app/marketing/restoration` requires the owner's normal shop PIN.
The browser tab is left at that sign-in for the owner. Never request the PIN or verification codes in chat.
The public booking host intentionally does not expose internal marketing pages.

## 6. Remaining follow-through
1. Owner signs into the Pitt Stop OS browser tab → verify the live restoration report and spend retrieval.
   New campaigns may have no reportable spend rows yet; missing data must remain Unavailable, not fabricated $0.
2. Monitor Google's ad/asset review and Search Console indexing. Campaigns are Enabled / Eligible (Learning),
   while the newly attached assets were Under review at their last inspection. Index requests are accepted,
   not proof of indexing or ranking.
3. Optional final 390 px visual pass on all five published pages when the viewport override works; link routing
   and tracking on the mobile-bar DOM are already verified on all five.
4. Operating cadence: review daily for the first 14 days, weekly thereafter. This is a documented manual
   cadence, NOT an installed automated monitor. Use the stop rules in GOOGLE_ADS_DRAFTS §6; labor/contribution
   is not a launch or performance gate while profitability is unmeasured.
5. GBP profile changes remain drafts. Existing GBP location asset is attached; no profile edits were made.

The +$5,000/month completed-restoration-revenue goal within 90 days is a **target, not an achievement**.

## Standing guardrails for any future session
- Never submit another live inquiry; never request secrets or verification codes.
- Enabled / Eligible (Learning) is verified. Do not claim ads actually served, assets approved, pages indexed/ranked,
  live spend sync verified, or any revenue achieved until each is independently verified and recorded here.
- Existing campaigns were untouched. Their combined $45/day plus the new $19.70/day makes the account total
  $64.70/day; the approved $600/month applies ONLY to these three new restoration campaigns.

---

## Earlier same-day snapshot (pre-deploy, superseded by the sections above — kept as dated history)
- Claude implementation session 34eac1d5-545a-4fb0-8ca8-c2620a25f49a; final correction turns completed without
  permission denials.
- Final env-free full suite: 253 files / 3,264 tests passed (an earlier unconstrained run had one 5-second
  invoice-consolidation timeout; the unchanged file passed all 55 separately).
- Browser checks: generated images load; single H1 and no desktop overflow on the WordPress hub draft; mobile
  local landing preview had no overflow; hero, mid and sticky links preserved incoming gclid/UTMs without
  forwarding email. Report synthetic fixtures showed unknown spend as Unavailable and profitability unmeasured.
- WordPress and Vercel logins verified; Search Console exact-property access verified. At that point the Vercel
  API showed the STARTING production `021f7c15836d53395f011787b4f5ddaf831071f3` (since superseded by the deploy
  in §1), the five pages were drafts, only the vandalism campaign shell existed, GA4 had received no stream
  data, and `GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON` was absent — all of which the sections above supersede.
