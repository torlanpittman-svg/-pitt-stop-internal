# Google Search campaigns — insurance restoration (ENABLED / ELIGIBLE — see RELEASE_PROGRESS_2026-11-07.md)

**Status 2026-11-07 — LAUNCHED.** All five CSV imports were APPLIED to account 684-374-8548
(zero-error preview before each Apply): 3 campaigns, 6 ad groups, 34 keywords, 157 negatives, 6 RSAs.
**All three campaigns are ENABLED / Eligible (Learning)** under the owner’s approval ($600/month for these
three only). Launch-state metrics were 0 impressions/clicks/cost; actual serving is not yet verified. Campaign IDs:
vandalism **24449757985**, overspray **24443961749**, water **24449757004**; budgets $9.00 / $6.00 / $4.70 daily
($19.70/day = $598.88 per 30.4-day month). Campaign-specific "Request quotes" goals only; `quote_requested`
(id 7893957510) Primary, no monetary value, not account default. New call asset (979) 696-6640, five sitelinks and
three callouts attached to all 3 — **Under review**, do not claim approved. Enabled is verified; actual serving is not yet verified.
The authoritative, dated execution record is `RELEASE_PROGRESS_2026-11-07.md`; the sections below remain the
DESIGN RATIONALE and the source-of-truth campaign content (`ads/*.csv`, revised 2026-11-07: no phone numbers in ad
text per https://support.google.com/adspolicy/answer/14848200 — six headlines now `Get Your Written Estimate`;
explicit `Ad type = Responsive search ad` column; no absolute glass-removal/total-loss lines; re-run the ≤30/≤90
length check after any future copy edit).

## 1. What the account's own history says (read-only, all time Dec 2019 – Nov 7 2026)
The paused **Hail Damage** Search campaign (id 22343541033, $29.09/day, Maximize conversions, 13 keywords all broad or
phrase, one ad group) is the closest thing to a restoration campaign this account has run:

| Keyword | Match | Clicks | Impr. | CTR | Avg. CPC | Cost | Conv. | Cost / conv. |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| hail damage repair | broad | 250 | 8,045 | 3.11% | $12.54 | $3,133.80 | 13.5 | $232.13 |
| dent damage repair | broad | 133 | 4,107 | 3.24% | $10.97 | $1,459.01 | 4.0 | $364.75 |
| hail repair near me | broad | 68 | 2,295 | 2.96% | $10.04 | $682.76 | 4.5 | $151.72 |
| hail repair college station | broad | 40 | 1,178 | 3.40% | $8.61 | $344.28 | 2.0 | $172.14 |
| (phrase keyword, label not captured) | phrase | 28 | 2,156 | 1.30% | $22.46 | $628.86 | 1.0 | $628.86 |
| (phrase keyword, label not captured) | phrase | 17 | 772 | 2.20% | $19.63 | $333.67 | 1.0 | $333.67 |
| **Total (rows with clicks)** | | **536** | | | **~$12.28** | **$6,582.38** | **26.0** | **~$253** |

The remaining 7 keywords show no all-time clicks; several are flagged "Rarely shown (low Quality Score)" or "Low search
volume". Two conclusions, both conservative:
- **Real CPCs in this account for damage-repair intent have been $9–$22 (≈ $12 blended), not the $2–$7 Keyword Planner
  suggests.** At $12 a click, $600 buys ~50 clicks a month across everything.
- **Blended cost per Google-counted conversion was ~$253 (best keyword $152)**, above the project's < $200 CAC target
  *before* counting that a Google conversion is a lead or call, not a completed job. The Day-90 CAC target is therefore
  a hypothesis to test with stop rules, not something the data supports in advance. Geo-modified terms ("college
  station") were the cheapest clicks, which is why the drafts use Presence targeting with phrase match rather than
  city words in every keyword.

## 2. Allocation (within the $600/month ceiling)
Google's budget mechanics (verified against Google Ads Help, 2026-11-07): daily spend can reach **2× the average daily
budget** on any day; monthly spend never exceeds **30.4 × daily budget**; changing a budget mid-month caps the month at
(already spent + new daily × remaining days). Since 2026-06-01 pacing spends toward the 30.4× monthly limit regardless of
ad schedule. So daily budgets are set from the monthly ceiling ÷ 30.4, and ad schedules narrow *when* ads show, not
how much is spent.

| Campaign | Priority | Daily budget | Monthly max (×30.4) | Why |
|---|---|---:|---:|---|
| PS Restoration – Vandalism & Break-in | 1 | **$9.00** | $273.60 | event-driven but the highest-ticket, fully in-house service; three tight ad groups (keyed paint, break-in cleanup, general) |
| PS Restoration – Overspray | 2 | **$6.00** | $182.40 | clearest demand pattern nationally (210/mo), local volume ~10/mo; phrase match + Bryan/College Station presence |
| PS Restoration – Water Damage | 3 | **$4.70** | $142.88 | spiky, weather-driven; two ad groups (wet interior, mildew odor) |
| **Total** | | **$19.70/day** | **$598.88** | under $600 even at full pacing |

Glass (priority 4) gets **no paid budget**: it is the only cluster with measurable local volume (40 + 20 searches/mo) but
also the one the shop does not fulfil in-house, and Keyword Planner bids run $2–$11. The glass landing page has no dedicated campaign; the Break-in cleanup ad group and glass sitelink can send
paid visitors to it. Windshield and hail/PDR: organic only, per the
brief. Hail keywords are explicit negatives on the vandalism campaign so the new campaigns never re-buy the $12 clicks
the paused Hail campaign bought.

## 3. Structure
- **Type:** Search only (no Display expansion, no Search Partners). **Bidding:** Maximize conversions with **no target CPA
  for the first 30 days** (the account has no restoration conversion history for a tCPA to learn from), then review.
- **Location:** College Station, TX + Bryan, TX, **Presence** ("people in or regularly in") — never "interest in".
  Add Brazos County as a radius alternative only if impressions are too thin after 14 days.
- **Language:** Google removed manual Search language targeting in Sep 2026 (UI shows “—”); English copy/keywords rely
  on automatic language matching — do not look for or gate on an English setting
  (https://support.google.com/google-ads/answer/1722078?hl=en-KY,
  https://ads-developers.googleblog.com/2026/08/google-ads-language-targeting-changes.html?m=0).
  **Schedule:** Mon–Sat 6 am–10 pm Central (shop hours plus the evening a car gets broken into), no Sunday.
- **Ad groups / keywords / match types:** see `keywords.csv` (34 keywords). Phrase match throughout plus an exact-match
  anchor on the head term of each theme (`[keyed car repair]`, `[car vandalism repair]`, `[car overspray removal]`).
  **No broad match**: the Hail campaign's broad keywords are what produced "rarely shown / low quality score" and the
  $12 CPC.
- **Negatives:** `negatives.csv` (157 rows, phrase match): shared list (DIY/how-to/product/retailer, insurance-shopping
  and insurer brand terms, legal, jobs, other Texas cities, RV/boat/motorcycle, "free") plus per-campaign lists
  (vandalism: windshield/glass replacement/Safelite/dent/PDR/body shop/repaint; overspray: spray guns/booths/house/roof
  coatings/tint; water: engine/radiator/hydrolock/sunroof replacement/salvage/junk-car). Review search terms weekly and
  promote new negatives.
- **Ads:** one responsive search ad per ad group (`ads_rsa.csv`, 8 headlines ≤ 30 chars, 4 descriptions ≤ 90 chars —
  copy revised 2026-11-07, lengths must be re-checked before import). Copy follows the landing-page guardrails:
  "itemized estimate for your claim", "coverage is your insurer's call", never "covered", "free", "deductible", any
  billing-status claim, absolute glass-removal promises or total-loss calls. Pin nothing; let Google test.
- **Final URLs:** the WordPress landing pages (`/car-vandalism-repair/`, `/auto-glass-repair/`, `/car-overspray-removal/`,
  `/car-water-damage/`). **Final URL suffix** per campaign carries `utm_source=google&utm_medium=cpc&utm_campaign=
  restoration_<type>&utm_content={adgroupid}&utm_term={keyword}&lp=<slug>`. The landing pages now SHIP an attribution
  pass-through script (render.ts, rev. 2026-11-07) that forwards the incoming allow-listed click parameters (gclid,
  utm_*, …) onto every estimate CTA and cross-page landing link — a paid click reaches `/quote` carrying its gclid/UTMs
  instead of being relabelled `utm_source=website`, and `classifySource` maps `gclid` → `google_ads` ahead of any utm.
  **Keep auto-tagging ON** (it appends the gclid to the landing-page URL the script forwards).
- **Assets (extensions), as ATTACHED 2026-11-07 (Under review):** call asset (979) 696-6640 (Mon–Fri 07–18, Sat 08–14;
  the account-level phone asset unchanged), existing GBP location asset (3112 Texas Avenue South), five sitelinks
  (Vandalism Repair, Overspray Removal, Water Damage Assessment, Auto Glass Assistance — "Glass service through our
  partner" — and the Insurance Restoration hub; existing "Contact Us" inherited), callouts "Itemized Estimates",
  "Photos Welcome", "College Station Shop" (≤25 chars).
- **Campaign category mapping for reporting:** DONE 2026-11-07 — `GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON` was added to the
  Vercel Production env with the three ids mapped to `restoration`, before application commit `0d35d6e` deployed
  READY through the normal GitHub workflow. The earlier manual redeploy/code prompt was cancelled. Live spend
  retrieval/display is still unverified pending shop-PIN sign-in at the internal `/marketing/restoration` report.

## 4. Conversion definitions (what "a conversion" means, and what it does not)
| Name | Where it fires | Counts as | Primary / secondary |
|---|---|---|---|
| `quote_requested` | GA4 event from `/quote` on a NEW (non-replayed) successful submission (`app/quote/conversion.ts`); payload = service type + opaque lead id only | a qualified-ish lead (photos + damage type + contact) | **Primary** for all three campaigns (import GA4 key event into Ads) |
| `booking_confirmed` | existing `/book` event | a booked appointment | secondary (restoration customers mostly go through /quote) |
| Call from ads | Google call asset, ≥ 60 s | a phone lead | secondary, observation only |
| Completed + invoiced job | **not a Google conversion** — it lives in Pitt Stop OS (`/marketing/restoration`, QB-anchored) | revenue | the real success metric; never upload to Google as value |

DONE 2026-11-07: `quote_requested` exists as conversion 7893957510 (GA4-linked), **Primary**, counting "First/one",
no monetary value, NOT the account default; one authorized test event (count 1) confirmed the pipe. Do not use
conversion value: Google's value is not revenue (see `apps/marketing/ads.ts` note).

## 5. Launch checklist (final launch status 2026-11-07 — see RELEASE_PROGRESS_2026-11-07.md)
1. ✅ Landing pages published (page ids 7630/7632/7634/7636/7638, labelled generated illustrations — real photos not required).
2. ✅ Migration 0076 applied + application SHA 0d35d6e deployed READY; `/quote` accepts damage types + `lp`; `quote_requested` fires.
3. ✅ `quote_requested` observed once (the single authorized test), key event + Primary conversion configured.
4. ✅ Query-string pass-through: the pages ship the attribution script; browser-verified that hero/mid/sticky CTAs retain gclid/UTMs.
5. ✅ Five CSVs applied (zero-error previews); UI verified: Search only, Presence, schedule, suffixes, negatives attached; all three campaigns now Enabled.
6. ✅ Billing: existing primary payment method confirmed present.
7. ✅ **All three campaigns enabled** — Google confirmed “3 campaigns enabled”; each shows Eligible (Learning).
   Existing campaigns stayed untouched. Google asset review/indexing and the signed-in spend-display check remain.
8. ✅ All five live pages republished with WordPress-safe tracking and corrected theme/mobile estimate links; final
   DOM checks passed. See RELEASE_PROGRESS for the final 390 px viewport limitation.

## 6. Monitoring cadence and stop criteria
This is a manual operating plan; no recurring monitor or automatic budget rule was installed.
- **Daily (first 14 days):** search terms report → add negatives; disapprovals; spend vs. 2× daily cap.
- **Weekly:** `/marketing/restoration` for leads by damage type / channel / landing page, cost per paid lead, blended
  cost per completed job, paid CAC, QB-invoiced revenue (profitability stays UNMEASURED — no contribution metric);
  Google Ads for CTR, CPC, impression share, conversions. Record the week per APPROVAL_PACKAGE §8 definitions.
- **Stop or pause a campaign when any of these holds for 14 consecutive days (or $150 spent, whichever first):**
  - 0 `quote_requested` conversions and 0 call conversions;
  - avg. CPC > $10 (the Hail history level) with CTR < 2%;
  - > 30% of clicks from search terms outside the restoration theme after negatives were added;
  - impression share < 10% with the budget "Limited by budget" and no conversions (we are being outbid; do not raise budget).
- **Stop the whole program when:** 60 days in, fewer than 4 estimates written from paid leads, or paid spend running
  well ahead of leads / completed jobs / QB-invoiced revenue with no improving trend. (The former modeled-contribution
  gate is REMOVED — profitability is unmeasured by owner decision, so judge on leads, completed jobs, invoiced revenue
  and actual spend.) Pausing is reversible; raising budgets is a new approval.
- **Never do automatically:** raise budgets, switch to broad match, turn on Display/Search Partners, accept Google
  "auto-apply" recommendations (the Ceramic/IGM campaigns already had auto-apply reviewed — keep it off here).

## 7. Scope notes (updated 2026-11-07)
- The "nothing created in the account" statement that originally stood here is HISTORY: the campaigns/ad groups/
  keywords/negatives/RSAs now EXIST in the account, with all three campaigns ENABLED (see the header and RELEASE_PROGRESS_2026-11-07.md).
  Only the three new campaigns were created; no existing campaign, budget or account setting was changed.
- No CPC or lead-volume forecast is given beyond the arithmetic above; local keyword volume is too thin to forecast and
  the only real account history ($12.54 CPC, $232/conv.) argues for caution.
- Call tracking via the Google call asset only (attached, Under review); no third-party call-tracking service.
