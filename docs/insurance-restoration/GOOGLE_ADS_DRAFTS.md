# Google Search campaign drafts — insurance restoration (LOCAL DRAFTS, nothing created in the account)

Status 2026-11-07: three Search campaigns are drafted as Google Ads Editor import files in `docs/insurance-restoration/ads/`
(`campaigns.csv`, `adgroups.csv`, `keywords.csv`, `negatives.csv`, `ads_rsa.csv`). **Every campaign row is `Paused`.**
Nothing has been imported, created, enabled or budgeted in account 684-374-8548. Importing them is itself a change to the
account and needs the owner's go-ahead; enabling them is the spending decision and needs separate, explicit approval.
The proposed $600/month is a ceiling to approve, not an approved spend.

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
| PS Restoration – Overspray | 2 | **$6.00** | $182.40 | clearest demand pattern nationally (210/mo), best in-house margin; local volume ~10/mo so phrase match + county-wide presence |
| PS Restoration – Water Damage | 3 | **$4.70** | $142.88 | spiky, weather-driven; two ad groups (wet interior, mildew odor) |
| **Total** | | **$19.70/day** | **$598.88** | under $600 even at full pacing |

Glass (priority 4) gets **no paid budget**: it is the only cluster with measurable local volume (40 + 20 searches/mo) but
also the one the shop does not fulfil in-house, and Keyword Planner bids run $2–$11. The glass landing page is organic
only, and the Break-in cleanup ad group sends glass-cleanup intent to it. Windshield and hail/PDR: organic only, per the
brief. Hail keywords are explicit negatives on the vandalism campaign so the new campaigns never re-buy the $12 clicks
the paused Hail campaign bought.

## 3. Structure
- **Type:** Search only (no Display expansion, no Search Partners). **Bidding:** Maximize conversions with **no target CPA
  for the first 30 days** (the account has no restoration conversion history for a tCPA to learn from), then review.
- **Location:** College Station, TX + Bryan, TX, **Presence** ("people in or regularly in") — never "interest in".
  Add Brazos County as a radius alternative only if impressions are too thin after 14 days.
- **Language:** English. **Schedule:** Mon–Sat 6 am–10 pm (shop hours plus the evening a car gets broken into), no Sunday.
- **Ad groups / keywords / match types:** see `keywords.csv` (34 keywords). Phrase match throughout plus an exact-match
  anchor on the head term of each theme (`[keyed car repair]`, `[car vandalism repair]`, `[car overspray removal]`).
  **No broad match**: the Hail campaign's broad keywords are what produced "rarely shown / low quality score" and the
  $12 CPC.
- **Negatives:** `negatives.csv` (157 rows, phrase match): shared list (DIY/how-to/product/retailer, insurance-shopping
  and insurer brand terms, legal, jobs, other Texas cities, RV/boat/motorcycle, "free") plus per-campaign lists
  (vandalism: windshield/glass replacement/Safelite/dent/PDR/body shop/repaint; overspray: spray guns/booths/house/roof
  coatings/tint; water: engine/radiator/hydrolock/sunroof replacement/salvage/junk-car). Review search terms weekly and
  promote new negatives.
- **Ads:** one responsive search ad per ad group (`ads_rsa.csv`, 8 headlines ≤ 30 chars, 4 descriptions ≤ 90 chars,
  length-checked). Copy follows the landing-page guardrails: "itemized estimate for your claim", "coverage is your
  insurer's call", never "covered", "free", "deductible", "we bill insurance". Pin nothing; let Google test.
- **Final URLs:** the WordPress landing pages (`/car-vandalism-repair/`, `/auto-glass-repair/`, `/car-overspray-removal/`,
  `/car-water-damage/`). **Final URL suffix** per campaign carries `utm_source=google&utm_medium=cpc&utm_campaign=
  restoration_<type>&utm_content={adgroupid}&utm_term={keyword}&lp=<slug>`; the page's estimate CTA passes the visitor
  on to `/quote` with `utm_source=website&utm_medium=landing&lp=<slug>` — so the **gclid** (auto-tagging, on) is what
  identifies the paid click on the quote form, and `classifySource` maps `gclid` → `google_ads` ahead of any utm.
  **Keep auto-tagging ON.** (Auto-tagging appends gclid to the landing page URL; the WordPress page must pass the query
  string through to the CTA link — see §6, launch check 4.)
- **Assets (extensions):** call asset (979) 696-6640 (tracked, business hours), location asset from the GBP, sitelinks to
  the four pages + /contact/, callouts "Written itemized estimates", "Photos welcome", "College Station shop".
- **Campaign category mapping for reporting:** add the three new campaign ids to `GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON`
  (Vercel Production env) as `"<id>": "restoration"` so `/marketing/restoration` and `/marketing/report` pick up spend.
  This is an env change in production and is part of the launch approval, not something done now.

## 4. Conversion definitions (what "a conversion" means, and what it does not)
| Name | Where it fires | Counts as | Primary / secondary |
|---|---|---|---|
| `quote_requested` | GA4 event from `/quote` on a NEW (non-replayed) successful submission (`app/quote/conversion.ts`); payload = service type + opaque lead id only | a qualified-ish lead (photos + damage type + contact) | **Primary** for all three campaigns (import GA4 key event into Ads) |
| `booking_confirmed` | existing `/book` event | a booked appointment | secondary (restoration customers mostly go through /quote) |
| Call from ads | Google call asset, ≥ 60 s | a phone lead | secondary, observation only |
| Completed + invoiced job | **not a Google conversion** — it lives in Pitt Stop OS (`/marketing/restoration`, QB-anchored) | revenue | the real success metric; never upload to Google as value |

Set `quote_requested` as a key event in GA4 only after the first real post-deploy event exists (same rule as the
booking event — see memory). Use count = **one per click** in Google Ads. Do not use conversion value: Google's value
is not revenue (see `apps/marketing/ads.ts` note).

## 5. Launch checklist (each item is a gate; none is done yet)
1. Landing pages published on WordPress with the final URLs above and real photos (approval needed).
2. Migration 0076 applied + this branch deployed so `/quote` accepts the damage types and `lp`, and `quote_requested` fires (approval needed).
3. GA4 `quote_requested` observed once from a real device, then starred as a key event and imported into Google Ads as the primary conversion (approval needed).
4. **Query-string pass-through test:** open a landing page with `?gclid=TEST&utm_source=google` and confirm the estimate CTA
   carries `gclid` and `lp` through to `/quote` (WordPress themes sometimes strip queries from cached pages). If not, the
   CTA must be built client-side from `location.search` — a small inline script to add to the WP page.
5. Import the five CSVs with Google Ads Editor, review in the Editor (campaigns stay Paused), post, then verify in the UI:
   networks = Search only, location option = Presence, ad schedule, suffix, negatives attached.
6. Billing: confirm the account's payment method and that total daily budget across ALL campaigns (existing $45/day + $19.70)
   is what the owner expects (~$1,967/month at full pacing).
7. **Enable** = the spend decision. Separate explicit approval.

## 6. Monitoring cadence and stop criteria
- **Daily (first 14 days):** search terms report → add negatives; disapprovals; spend vs. 2× daily cap.
- **Weekly:** `/marketing/restoration` for leads by damage type / channel / landing page, CPL, CAC, contribution; Google
  Ads for CTR, CPC, impression share, conversions. Record the week in the weekly report (docs/insurance-restoration/APPROVAL_PACKAGE.md §Reporting).
- **Stop or pause a campaign when any of these holds for 14 consecutive days (or $150 spent, whichever first):**
  - 0 `quote_requested` conversions and 0 call conversions;
  - avg. CPC > $10 (the Hail history level) with CTR < 2%;
  - > 30% of clicks from search terms outside the restoration theme after negatives were added;
  - impression share < 10% with the budget "Limited by budget" and no conversions (we are being outbid; do not raise budget).
- **Stop the whole program when:** 60 days in, fewer than 4 estimates written from paid leads, or modeled contribution
  after ads negative two months running. Pausing is reversible; raising budgets is a new approval.
- **Never do automatically:** raise budgets, switch to broad match, turn on Display/Search Partners, accept Google
  "auto-apply" recommendations (the Ceramic/IGM campaigns already had auto-apply reviewed — keep it off here).

## 7. What was NOT done and why
- No campaign, ad group, keyword, ad or budget was created or changed in Google Ads. Drafts are files only.
- No CPC or lead-volume forecast is given beyond the arithmetic above; local keyword volume is too thin to forecast and
  the only real account history ($12.54 CPC, $232/conv.) argues for caution.
- Call tracking numbers (Google forwarding) are proposed via the call asset only; no third-party call-tracking service.
