# Restoration release progress — 2026-11-07

Owner approved release and an initial $600/month Google Ads budget. Glass replacement is provided by the third-party partner. Generated illustrations are approved and visibly labelled. Labor-cost entry is not required; profitability is unmeasured.

## Independently verified
- Claude implementation session: 34eac1d5-545a-4fb0-8ca8-c2620a25f49a; final two correction turns completed successfully without permission denials.
- Final env-free full suite: 253 files, 3264 tests passed. The earlier unconstrained run had one 5-second invoice-consolidation timeout; the unchanged file passed all55 separately and the final full run passed with4workers.
- Production Next webpack build succeeded. All release-source ESLint errors corrected. Standalone tsc reports10 existing test-fixture errors in unchanged apps/estimates/quickbooks.test.ts; Next production typechecking passed.
- Browser checks: generated images load, single H1 and no desktop overflow on WordPress hub draft; mobile local landing preview has no overflow; hero, mid and sticky links preserve incoming gclid/UTM without forwarding email. Report synthetic fixtures show unknown spend as unavailable and profitability as unmeasured.
- All6 ad rows meet30-character headline and90-character description limits.
- WordPress and Vercel logins verified; Search Console exact-property access verified. Vercel API confirms starting READY production021f7c15836d53395f011787b4f5ddaf831071f3.
- Migration0076 applied and verified on the intended production endpoint at2026-11-07T21:37:50Z: five additive columns and one partial index. No customer records inserted/updated/deleted; application guard unchanged.

## External setup (not a launch claim)
- WordPress media7626–7629: four illustrations uploaded, alt text and explicit illustration captions saved. PublicURLs recorded in assets.json.
- Five WordPress drafts: hub7630, vandalism7632, overspray7634, water7636, glass7638. SEO title/description and intended slugs configured; final hub/vandalism copy refresh and publication remain.
- Three Google Ads campaign shells created and verified Paused, zero spend: vandalism$9/day, overspray$6/day, water$4.70/day (combined$598.88 for30.4days). No unrelated campaigns changed. Vandalism campaign24449757985. Ad groups, keywords, negatives, ad copy and conversion-specific goals still require setup.
- GA4 quote_requested created as a key event, with no invented monetary value, once per event. No stream data received yet; no live test submission sent.
- Vercel production NEXT_PUBLIC_GA_MEASUREMENT_ID exists. GOOGLE_ADS_CAMPAIGN_CATEGORIES_JSON absent from project/shared lists and remains to be added for new campaign IDs.

## Remaining release checks
Deploy exact reviewed commit and verify READY via Vercel API; verify live quote form; publish five pages and check canonical/meta/links/mobile rendering; connect campaign-specific quote conversion, complete paused ad imports/targeting/mapping; verify a real authorized test or customer conversion before enabling; request Search Console indexing. No renewed budget approval needed.
