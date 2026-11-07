# Google Business Profile prep + review-request process — insurance restoration (DRAFT, nothing published)

Status 2026-11-07: **prepared only.** GBP was not opened this session (the manager account needs an interactive account
pick; see CAPABILITY_READINESS row 9). Every item below is a proposed edit for the owner to approve and apply, or to
have applied on approval. Nothing here changes the live profile.

## 1. Profile facts to re-verify before any edit
Read from the live website 2026-11-07 — confirm the profile matches:
- Name: Pitt Stop Detail & Auto Sales · 3112 Texas Ave S, College Station, TX 77845 · (979) 696-6640
- Hours: Mon–Fri 7 am–6 pm, Sat 8 am–2 pm (check holiday hours for Thanksgiving week, 2026-11-26/27)
- Website link: keep the homepage. Booking link: `https://book.pittstopdetailandautosales.com/book?utm_source=google&utm_medium=gbp`
  (already saved per memory `website-booking-cta`; verify it still shows).

## 2. Categories (proposal)
Primary category stays whatever it is today (likely **Car detailing service**). Proposed additional categories, in order:
1. **Auto restoration service** — exists in Google's category list; matches vandalism/overspray/water work.
2. **Car wash** / **Auto body shop**: do **not** add Auto body shop (we don't do panel/paint repair; a wrong category
   draws wrong calls and reviews). Keep whatever secondary categories already exist unless they are wrong.
3. **Auto glass shop**: do **not** add. We don't replace glass (see auto-glass-repair page wording).

## 3. Services section — draft descriptions (≤ 300 chars each, GBP limit)
Add under a "Restoration" service group. Prices: leave blank (GBP "price" fields) — estimates are written per vehicle.

| Service name | Description (draft) |
|---|---|
| Vandalism & break-in restoration | Keyed or scratched paint assessed and polished where it can be, spray paint and adhesive removed, every piece of broken glass out of seats, carpet and vents, interior cleaned and deodorized. Written, itemized estimate with photos for your insurance claim. |
| Paint overspray removal | Construction, roofing or industrial overspray lifted from paint, glass, trim and wheels with clay, solvents and machine polishing, without repainting. Test spot first. Itemized estimate and photos you can send to the contractor's insurer or yours. |
| Water damage restoration | Rain, leak or spill damage: hot-water extraction of carpet, padding and seats, forced drying, mildew and odor treatment, carpet or padding replacement when needed. We tell you honestly if a flooded vehicle is beyond restoring. |
| Broken glass cleanup | After a smashed side or rear window: complete removal of glass from seat tracks, vents, carpet and door cavities, interior and paint damage from the break repaired, scheduled around your glass installer. We do not replace glass. |

Guardrails (same as the pages): no "covered by insurance", no "we bill your insurer", no deductible language, no
turnaround promises.

## 4. "From the business" description — one new sentence to add (not a rewrite)
> We also restore vehicles after vandalism, paint overspray, water intrusion and break-ins, and write itemized estimates
> you can submit with an insurance claim.

## 5. Photos — selection rules
GBP photos must be real shop photos. Candidates to shoot (same list as the landing pages' REQUIRED ASSETS):
- keyed panel before/after (vandalism), glass fragments removed from seat tracks (glass), overspray specks before/after
  (overspray), extraction in progress + dried carpet (water), one wide bay shot, one estimate-on-clipboard shot.
- Upload rules: landscape, ≥ 1200 px wide, no stock, no text overlays, customer plates blurred, permission for any
  identifiable vehicle. Caption with the service name.
- Do NOT reuse the ceramic/paint-correction marketing images for restoration.

## 6. Google Posts (optional, after launch) — two drafts
1. "Parked near a job site and your car came back speckled? That's overspray, and it usually comes off without repainting.
   Send us photos for a written estimate." → CTA Learn more → `/car-overspray-removal/`
2. "Window smashed? The glass shop replaces the window. We get every shard out of your seats and vents and fix what the
   break damaged. Written estimate for your claim." → CTA Learn more → `/auto-glass-repair/`

## 7. Review-request process (no new software, no cost)
Goal: a steady trickle of **restoration-specific** reviews that mention the service, from genuinely finished jobs.
1. **Who asks, when:** the manager who delivers the vehicle asks in person at pickup, only after the customer has seen the
   result and paid. Not for jobs with an open insurer dispute, not for total-loss conversations.
2. **How:** the existing GBP review short link (Business Profile → "Ask for reviews" → copy link). Send it by the channel
   the customer already used with us (email reply from `service@pittstopbcs.com`, or text from a personal shop phone).
   There is no SMS system in Pitt Stop OS; do not build one for this.
3. **Script (email, plain):**
   > Subject: Thanks from Pitt Stop — one quick favor
   > Hi {first name}, glad the {damage type} work on your {vehicle} came out right. If you have a minute, a Google review
   > helps the next person who's searching after a break-in or a bad day find us. Here's the link: {review link}.
   > If anything isn't right, reply to this email first and we'll fix it. — {manager name}, Pitt Stop Detail & Auto Sales
4. **Rules:** never offer anything for a review (gift cards, discounts); never gate ("only if you're happy"); never write
   or edit a customer's review; one ask, one gentle follow-up after 7 days, then stop.
5. **Respond** to every restoration review within 2 business days; thank, name the service generically ("overspray
   removal"), never confirm claim/insurer details publicly.
6. **Track:** add a `review_asked` note on the lead (Leads page notes field) so the restoration report's lead table shows
   who was asked. (No schema change needed; a future column can replace the note if volume justifies it.)

## 8. What needs the owner
- Approve categories/services/description text above.
- Confirm GBP manager account and complete the account pick in the automation browser, or apply the edits personally.
- Supply the photos in §5.
