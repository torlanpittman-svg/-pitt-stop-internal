/**
 * Content for the five insurance-restoration landing pages on the WordPress site
 * (www.pittstopdetailandautosales.com). Pages are DATA here; `render.ts` turns each into
 *   - a standalone preview (dist/<slug>.preview.html) for owner review, and
 *   - a WordPress-ready body (dist/<slug>.wp.html) to paste into a Custom HTML block, plus
 *   - dist/<slug>.json with the SEO title, meta description, slug and FAQ JSON-LD for Rank Math.
 * Build: `npx tsx scripts/build-restoration-pages.ts`. Nothing here publishes anything.
 *
 * Writing rules (enforced by pages.test.ts):
 *   - insurance language is QUALIFIED: "may be covered", "your insurer decides"; never guaranteed coverage,
 *     free repairs, waived deductibles, guaranteed approval or reimbursement, and no direct-billing claim
 *     (that capability is UNVERIFIED — see docs/insurance-restoration/README.md §1.5);
 *   - every page distinguishes what the shop does from what it does not (glass replacement, structural/body
 *     work, severe flood / total loss);
 *   - no fabricated photos, reviews, prices or turnaround promises. Photos are listed as REQUIRED ASSETS and
 *     rendered as labelled placeholders in the preview only;
 *   - facts (phone, address, hours) come from the live site as read on 2026-11-07.
 */
import type { QuoteService } from '@/apps/marketing/quote-shared'

export const SITE = 'https://www.pittstopdetailandautosales.com'
export const BOOK_HOST = 'https://book.pittstopdetailandautosales.com'
export const SHOP = {
  name: 'Pitt Stop Detail & Auto Sales',
  phone: '(979) 696-6640',
  tel: '+19796966640',
  street: '3112 Texas Ave S',
  city: 'College Station',
  state: 'TX',
  zip: '77845',
  hours: 'Mon–Fri 7 am–6 pm · Sat 8 am–2 pm',
  openingHours: ['Mo-Fr 07:00-18:00', 'Sa 08:00-14:00'],
  area: 'Bryan–College Station, Texas',
}
export const CAMPAIGN = 'insurance_restoration'

export interface Faq { q: string; a: string }
export interface PhotoNeed { id: string; caption: string; note: string }
export interface Section { heading: string; paras?: string[]; bullets?: string[]; steps?: string[]; callout?: { tone: 'yellow' | 'navy'; text: string } }
export interface LandingPage {
  slug: string
  service: QuoteService | null        // null = hub page (CTAs go to the per-type cards)
  seoTitle: string                    // ≤ 60 chars
  metaDescription: string             // ≤ 155 chars
  kicker: string
  h1: string
  lede: string
  trust: string[]
  sections: Section[]
  insurance: { heading: string; paras: string[] }
  photos: PhotoNeed[]
  faqs: Faq[]
  related: string[]                   // slugs
  ctaLabel: string
}

/** The one sentence every page must carry, verbatim or near it (tested). */
export const INSURER_DECIDES = 'Coverage, and what your deductible is, are always your insurance company’s decision, never ours.'
/** Direct billing is unverified, so every page says the same thing. */
export const NO_DIRECT_BILLING = 'We don’t bill your insurance company for you: you receive a written, itemized estimate and photos you can submit with your claim, and we work from the estimate once you decide to proceed.'

export const PAGES: LandingPage[] = [
  {
    slug: 'insurance-auto-repair',
    service: null,
    seoTitle: 'Insurance Auto Restoration in College Station | Pitt Stop',
    metaDescription: 'Vandalism, paint overspray, water damage and broken-glass cleanup in Bryan–College Station. Itemized written estimates you can submit to your insurer.',
    kicker: 'Bryan–College Station, TX',
    h1: 'Insurance-Related Auto Restoration, Written Up Properly',
    lede: 'Something happened to your vehicle that you didn’t cause: a break-in, a contractor’s overspray, a window left open in a storm. We restore what can be restored and give you a clear, itemized estimate you can hand to your insurance company.',
    trust: ['Written, itemized estimates with photos', 'Detail, paint and interior restoration under one roof', 'Honest about what can’t be fixed', `${SHOP.street}, ${SHOP.city}`],
    sections: [
      {
        heading: 'What we restore',
        paras: ['Pick the situation that matches yours. Each page explains what we can do, what we can’t, and how insurance usually treats it.'],
        bullets: [
          '[[car-vandalism-repair|Vandalism and break-in restoration]]: keyed paint, spray paint, broken-glass cleanup, damaged or soiled interiors.',
          '[[car-overspray-removal|Paint overspray removal]]: construction, roofing and industrial overspray lifted off paint, glass and trim without repainting.',
          '[[car-water-damage|Water damage restoration]]: rain and leak intrusion, wet carpet and padding, odor and mildew prevention.',
          '[[auto-glass-repair|Broken glass and interior cleanup]]: the glass is replaced by a glass shop; we handle everything the break left behind.',
        ],
      },
      {
        heading: 'How it works',
        steps: [
          'Send photos and a short description through our estimate form, or call the shop.',
          'We review the damage and reply with next steps during business hours. Some jobs we can estimate from photos; others need a look in person.',
          'You receive a written, itemized estimate with photos. If you are filing a claim, that is what you send your insurer or show the adjuster.',
          'Once you (and your insurer, if you are claiming) decide to proceed, we schedule the work and keep you posted until pickup.',
        ],
      },
      {
        heading: 'What we are honest about',
        bullets: [
          'Deep scratches that are through the clear coat and paint need a body shop. We will tell you that instead of polishing something that cannot be polished.',
          'We are not a glass shop. We coordinate the cleanup and interior side and can work alongside whichever glass shop you or your insurer choose.',
          'Severe flooding (water above the seat bottoms, submerged electronics, standing water for days) is often a total-loss conversation with your insurer, not a restoration job. We will say so.',
          'Hail and dent repair: ask us. We will point you to the right option for the damage rather than promise a result.',
        ],
      },
    ],
    insurance: {
      heading: 'Working with your insurance',
      paras: [
        'Vandalism, falling objects, water and glass damage are typically handled under the comprehensive portion of an auto policy, but every policy is different, and some people choose to pay out of pocket to protect their rates. ' + INSURER_DECIDES,
        NO_DIRECT_BILLING + ' If an adjuster wants to see the vehicle or talk through the estimate, we are glad to walk them through it.',
      ],
    },
    photos: [
      { id: 'hub-hero', caption: 'Our College Station shop with a vehicle on the restoration bay', note: 'Wide exterior or bay shot of the real shop. No stock imagery.' },
      { id: 'hub-estimate', caption: 'An itemized Pitt Stop estimate beside the photos it was built from', note: 'Photograph a real (customer details redacted) estimate printout or screen.' },
    ],
    faqs: [
      { q: 'Do I have to file an insurance claim to use you?', a: 'No. Many customers pay out of pocket, especially when the repair is close to their deductible. You get the same written estimate either way, so you can decide after you see the number.' },
      { q: 'Will you talk to my adjuster?', a: 'Yes. We will explain the estimate line by line and show the adjuster the damage in person or by photo. The coverage decision stays with your insurer.' },
      { q: 'How fast can you look at my vehicle?', a: 'Send photos through the estimate form and we will reply with next steps during business hours. If the damage needs an in-person look, we will tell you when to bring it by.' },
      { q: 'Do you repair body damage or replace glass?', a: 'We are a detail and restoration shop. We handle paint correction, interior restoration, odor and cleanup. Dents, panel repair and glass replacement go to a body or glass shop, and we are happy to work alongside them.' },
    ],
    related: ['car-vandalism-repair', 'car-overspray-removal', 'car-water-damage', 'auto-glass-repair'],
    ctaLabel: 'Request an estimate',
  },
  {
    slug: 'car-vandalism-repair',
    service: 'vandalism',
    seoTitle: 'Car Vandalism & Break-In Cleanup | College Station, TX',
    metaDescription: 'Keyed paint, spray paint, glass inside the car, soiled interiors. Pitt Stop restores vandalized vehicles in Bryan–College Station and documents your claim.',
    kicker: 'Vandalism & break-ins',
    h1: 'Vandalism and Break-In Restoration',
    lede: 'A keyed door, a smashed window, spray paint, a glovebox dumped on the floor. Our job is to get the vehicle back to looking and smelling like yours, and to document everything so your claim goes smoothly.',
    trust: ['Scratch assessment: polish vs. repaint, explained honestly', 'Every shard of glass out of seats, carpet and vents', 'Spray paint and adhesive removal', 'Interior cleaning, odor treatment and upholstery repair'],
    sections: [
      {
        heading: 'What we do after a break-in or vandalism',
        bullets: [
          'Keyed and scratched paint: we measure how deep the scratch goes. Scratches in the clear coat can usually be polished out; scratches to primer or metal need paint, and we will tell you which is which.',
          'Spray paint, markers, egg and adhesive: removed from paint, glass and trim with methods that lift the contaminant rather than grind the finish.',
          'Broken glass cleanup: tempered glass shatters into thousands of pieces that travel into seat tracks, vents and under carpet. We remove them so nobody finds one later.',
          'Interior restoration: dumped contents, spills, footprints, cut seats and torn panels. Shampoo, extraction, upholstery repair and odor treatment as needed.',
          'Documentation: dated photos of every damaged area and an itemized estimate you can submit with a police report and claim.',
        ],
      },
      {
        heading: 'What to do right now',
        steps: [
          'If anything was stolen, file a police report. Insurers usually ask for the report number on a vandalism or theft claim.',
          'Photograph everything before you clean anything, including the ground around the vehicle and any note or tag left behind.',
          'Cover a broken window with plastic and tape to keep rain out. Do not vacuum glass with a household vacuum; it will not survive.',
          'Send us the photos. We will tell you what can be restored and what needs a body or glass shop.',
        ],
      },
      {
        heading: 'What we do not do',
        bullets: ['Panel replacement, dent repair and repainting are body-shop work. We will say so plainly if that is what your vehicle needs.', 'Glass replacement itself is done by a glass shop; see our [[auto-glass-repair|broken glass and interior cleanup]] page for how that fits together.'],
        callout: { tone: 'yellow', text: 'Deep scratches: if you can catch a fingernail in the scratch, it is probably through the clear coat. We can still improve how it looks, but we will not promise it disappears.' },
      },
    ],
    insurance: {
      heading: 'Vandalism and your insurance',
      paras: [
        'Vandalism is typically a comprehensive claim, not collision, and comprehensive claims often do not affect your rate the way an at-fault accident does, but that depends on your policy and your insurer. If the repair is close to your deductible, many people simply pay out of pocket. ' + INSURER_DECIDES,
        NO_DIRECT_BILLING,
      ],
    },
    photos: [
      { id: 'vandal-keyed-before-after', caption: 'Keyed door panel before and after paint correction', note: 'Real customer vehicle, permission on file. Same angle, same light for both shots.' },
      { id: 'vandal-glass-cleanup', caption: 'Shattered side glass removed from seat tracks and carpet', note: 'Interior shot during cleanup.' },
    ],
    faqs: [
      { q: 'Can keyed paint be fixed without repainting?', a: 'Often, if the scratch is only in the clear coat. We polish the area and blend it. If the key went through to primer or metal, the panel needs paint, which is body-shop work; we will tell you which case you have before any work starts.' },
      { q: 'Do I need a police report?', a: 'For a vandalism or theft claim your insurer will usually want a report number. For the estimate itself we do not need it, so send photos first and file the report in parallel.' },
      { q: 'Will a vandalism claim raise my rates?', a: 'Vandalism is normally a comprehensive claim, which many insurers treat differently from an at-fault accident, but it varies by company and policy. Ask your agent. We can give you the estimate first so you can decide whether to claim.' },
      { q: 'Can you get all the glass out of the car?', a: 'Yes. Tempered glass spreads into seat tracks, door cavities, vents and under the carpet, so we remove seats and trim where needed and vacuum, brush and blow every cavity out.' },
      { q: 'How long does it take?', a: 'It depends on the damage. Light scratch polishing and glass cleanup is often a same-day or next-day job once scheduled; interior repairs take longer. We give you a time estimate with the written estimate.' },
    ],
    related: ['auto-glass-repair', 'insurance-auto-repair', 'car-water-damage'],
    ctaLabel: 'Request a vandalism estimate',
  },
  {
    slug: 'car-overspray-removal',
    service: 'overspray',
    seoTitle: 'Car Paint Overspray Removal | Bryan–College Station, TX',
    metaDescription: 'Overspray on your car from a job site or roofing crew? Pitt Stop lifts it off paint, glass and trim without repainting, and documents it for a claim.',
    kicker: 'Overspray removal',
    h1: 'Paint Overspray Removal Without Repainting',
    lede: 'You parked near a job site, a freshly coated roof or a painting crew, and now the car feels like sandpaper and looks speckled. Overspray sits on top of your clear coat. In most cases we can lift it off rather than repaint.',
    trust: ['Clay, chemical and machine-polish removal matched to the contaminant', 'Paint, glass, trim, wheels and lights', 'Documented for the painter’s insurer or yours', 'No repaint unless the finish is actually damaged'],
    sections: [
      {
        heading: 'How overspray removal works',
        paras: ['Overspray is dried paint or coating bonded to the surface of your clear coat, glass and plastics. Because it sits on top, it can usually be removed by dissolving or shearing it off and then refining the finish underneath.'],
        bullets: [
          'Assessment: we test an inconspicuous area to identify the material (latex, enamel, epoxy, roofing coating, industrial fallout) and choose the method.',
          'Removal: detailing clay and overspray-specific solvents on paint and glass; careful scraping on glass; dedicated products for rubber, plastic trim and wheels.',
          'Refinement: a machine polish to remove any marring from the removal step and restore gloss.',
          'Protection: a sealant or wax so the surface is protected afterward.',
        ],
      },
      {
        heading: 'What to do right now',
        steps: [
          'Do not scrub it. Dry rubbing grinds the particles into the clear coat and turns a removable problem into a repaint.',
          'Photograph the vehicle where it sits, the source of the overspray if you can see it, and any posted contractor sign.',
          'Get the contractor’s or property manager’s name and insurance information. Overspray is often covered by the painter’s liability policy.',
          'Send us the photos. Fresh overspray is easier to remove than overspray that has baked on for weeks.',
        ],
      },
      {
        heading: 'What we are honest about',
        bullets: ['Some coatings, especially catalyzed industrial paints left on for a long time, can bond to the point that removal marks the clear coat. We will tell you if we see that risk during the test spot.', 'Convertible fabric tops and some matte or satin finishes need a different approach, and in some cases replacement. We will assess before quoting.'],
        callout: { tone: 'navy', text: 'Bring the contractor’s details. A clear written estimate and photos make it much easier for their insurer, or yours, to process the claim.' },
      },
    ],
    insurance: {
      heading: 'Overspray and insurance',
      paras: [
        'Overspray damage is often handled one of two ways: a claim against the responsible contractor’s liability insurance, or a comprehensive claim on your own policy. Which route is better depends on the deductibles involved and how cooperative the contractor is. ' + INSURER_DECIDES,
        NO_DIRECT_BILLING,
      ],
    },
    photos: [
      { id: 'overspray-before-after', caption: 'Overspray speckling on a hood before and after removal', note: 'Macro shot of the specks plus the same panel after. Real vehicle.' },
      { id: 'overspray-test-spot', caption: 'Test spot during assessment', note: 'Shows the method is matched to the coating.' },
    ],
    faqs: [
      { q: 'Does overspray removal damage the paint?', a: 'Done correctly, no. Overspray sits on top of the clear coat and is lifted off with clay and solvents, then the area is polished. The risk comes from dry scrubbing or using the wrong product, which is why we test a small area first.' },
      { q: 'Who pays for overspray damage?', a: 'Often the contractor’s liability insurance, sometimes your own comprehensive coverage, and sometimes the customer when the amount is small. We provide the estimate and photos; the insurer or contractor decides what they will pay.' },
      { q: 'How soon should it be removed?', a: 'Sooner is easier. Overspray that has cured in the Texas sun for weeks bonds harder and takes more work to remove, which affects the estimate.' },
      { q: 'Can you remove overspray from glass and trim too?', a: 'Yes. Glass, headlights, black trim, rubber seals and wheels each need their own method, and all of them are part of a full overspray removal.' },
    ],
    related: ['insurance-auto-repair', 'car-vandalism-repair'],
    ctaLabel: 'Request an overspray estimate',
  },
  {
    slug: 'car-water-damage',
    service: 'water_damage',
    seoTitle: 'Car Water Damage Restoration | College Station, TX',
    metaDescription: 'Rain through a window, a leaking seal, a soaked floorboard. Pitt Stop extracts, dries and restores wet car interiors in Bryan–College Station, honestly.',
    kicker: 'Water damage',
    h1: 'Water Damage Restoration for Car Interiors',
    lede: 'Wet carpet does not dry on its own in a closed car. It sours, grows mildew and works into the padding underneath. The faster the water is extracted and the interior properly dried, the more we can save.',
    trust: ['Hot-water extraction of carpet, padding and seats', 'Drying with airflow, not just time', 'Odor and mildew treatment, including ozone where appropriate', 'Soaked carpet and padding replacement when drying is not enough'],
    sections: [
      {
        heading: 'What we do for a wet interior',
        bullets: [
          'Find the source: an open window, a sunroof drain, a door or windshield seal, a clogged cowl. Restoring the interior without fixing the leak just repeats the problem.',
          'Extract: hot-water extraction pulls water out of carpet, padding and seat foam. Where needed we lift carpet to reach the padding and the floor pan.',
          'Dry: forced airflow and, where appropriate, removal of saturated padding. We check moisture before we call it done.',
          'Treat: shampoo, antimicrobial treatment and odor removal so the mildew smell does not come back. Ozone treatment is used where it is appropriate for the vehicle.',
          'Replace: when carpet or padding is too far gone to save, we replace it. We already do soaked-carpet and upholstery replacement as part of our interior work.',
        ],
      },
      {
        heading: 'What to do right now',
        steps: [
          'Get the water out of the car as soon as you can: towels, a wet-dry vacuum, open doors in the shade. Every day the carpet stays wet makes it harder to save.',
          'Photograph the waterline and every wet area before anything is removed.',
          'Do not start the car if water reached the dash, the seats’ electrical connectors or the floor-mounted modules. Have it looked at first.',
          'Send us the photos and tell us how high the water got. That one detail changes what we recommend.',
        ],
      },
      {
        heading: 'Repairable water damage vs. a flooded vehicle',
        paras: ['These are different situations, and we will tell you which one you have.'],
        bullets: [
          'Repairable: rain through an open window or sunroof, a leaking seal, a spilled cooler, a wet floorboard from a clogged drain. The interior is saved with extraction, drying and treatment, sometimes with new carpet or padding.',
          'Flooded: water above the seat bottoms, water in the dash or electrical modules, standing water for days, or any saltwater or sewage contamination. Electrical and corrosion problems show up for months. This is usually a conversation with your insurer about the vehicle’s value, and we will not sell you an interior restoration on a car that should be totaled.',
        ],
        callout: { tone: 'yellow', text: 'Mildew can start within a day or two in a closed, warm car. If the interior is wet, treat it as urgent.' },
      },
    ],
    insurance: {
      heading: 'Water damage and insurance',
      paras: [
        'Flood and water damage from storms is typically handled under comprehensive coverage. Water that got in because a window was left open may be treated differently by some insurers, and a slow leak from a worn seal is usually considered maintenance. ' + INSURER_DECIDES,
        NO_DIRECT_BILLING + ' If the vehicle may be a total loss, we will tell you that before you spend money on an estimate you will not use.',
      ],
    },
    photos: [
      { id: 'water-extraction', caption: 'Hot-water extraction of a saturated floorboard', note: 'Real job in progress, carpet lifted.' },
      { id: 'water-before-after', caption: 'Water-stained carpet before and after restoration', note: 'Same area, same angle.' },
    ],
    faqs: [
      { q: 'Can a water-damaged car interior be saved?', a: 'Usually yes when the water came from rain, a leak or a spill and is dealt with quickly. Carpet, padding and seats can be extracted, dried and treated, or replaced if needed. A vehicle that was flooded above the seats or had water in the electronics is a different situation, and we will tell you if that is the case.' },
      { q: 'How quickly does mildew start?', a: 'In a closed car in Texas heat, often within one to two days. The sooner the interior is extracted and dried, the less treatment it needs and the more likely the original carpet can be saved.' },
      { q: 'Do you fix the leak too?', a: 'We find where the water came in and clear drains and simple seal issues as part of the job. Body seam or windshield-seal repairs may need a glass or body shop, and we will tell you if that is what we find.' },
      { q: 'Will insurance cover water damage to my car?', a: 'Storm and flood damage is typically a comprehensive claim, while damage from a window left open or a worn seal may be handled differently. Your insurer decides. We provide the written estimate and photos you need to ask the question.' },
      { q: 'Is ozone treatment safe for my car?', a: 'Used correctly and in the right situations it is an effective odor treatment. We decide whether it is appropriate for your vehicle and materials, and we never use it as a substitute for actually drying and cleaning the interior.' },
    ],
    related: ['insurance-auto-repair', 'car-vandalism-repair', 'auto-glass-repair'],
    ctaLabel: 'Request a water damage estimate',
  },
  {
    slug: 'auto-glass-repair',
    service: 'glass',
    seoTitle: 'Broken Car Window Cleanup | College Station, TX | Pitt Stop',
    metaDescription: 'Side or rear window smashed? Pitt Stop clears every piece of glass from the interior, repairs the damage and works alongside your glass shop in College Station.',
    kicker: 'Broken glass',
    h1: 'Broken Side and Rear Glass: Cleanup, Interior Repair and Coordination',
    lede: 'The glass shop replaces the window. The glass that exploded into your seats, carpet, vents and door is still your problem, and so is whatever else the break damaged. That part is ours.',
    trust: ['Every shard out of seat tracks, vents, carpet and door cavities', 'Interior and paint damage from the break-in restored', 'We work alongside the glass shop you or your insurer choose', 'Itemized estimate for your comprehensive or glass claim'],
    sections: [
      {
        heading: 'What we do when a window is broken',
        bullets: [
          'Complete glass removal: tempered side and rear glass breaks into thousands of pieces that end up under seats, inside door panels, in vents and defroster ducts. We remove trim and seats as needed and clear every cavity.',
          'Interior repair: cut or scuffed seats, scratched panels, a dumped console, footprints and spills from the break-in.',
          'Paint around the opening: scratches and scuffs on the door frame or quarter panel from the break or the tool used.',
          'Weather protection: we can secure the opening with a temporary cover while the replacement glass is on the way.',
          'Coordination: we schedule around the glass installer so the interior is clean before the new glass goes in, and you are not vacuuming glass out of your defroster next summer.',
        ],
      },
      {
        heading: 'What we are honest about',
        paras: ['We are a detail and restoration shop, not a glass shop. We do not stock or install glass. In Bryan–College Station there are several established auto-glass installers, and many insurers have a preferred glass network; use whichever you and your insurer prefer, and we will handle everything around it.'],
        callout: { tone: 'navy', text: 'Windshields: windshield chips and cracks are a glass-shop job and often a separate glass-coverage claim. We do not repair windshields.' },
      },
      {
        heading: 'What to do right now',
        steps: [
          'If it was a break-in, file a police report and photograph the vehicle before touching anything.',
          'Cover the opening with plastic and tape so rain and more debris stay out.',
          'Call your insurer or glass network to arrange the replacement glass, and send us photos so the cleanup and interior repair can be scheduled around it.',
        ],
      },
    ],
    insurance: {
      heading: 'Glass, cleanup and your insurance',
      paras: [
        'Broken glass from a break-in or vandalism is typically part of a comprehensive claim, and some policies carry separate glass coverage with its own deductible. The interior cleanup and repair that goes with a break-in is usually part of the same claim, and we itemize it so the adjuster can see exactly what was done and why. ' + INSURER_DECIDES,
        NO_DIRECT_BILLING,
      ],
    },
    photos: [
      { id: 'glass-cleanup-tracks', caption: 'Glass fragments removed from seat tracks and the door cavity', note: 'Real cleanup in progress.' },
      { id: 'glass-finished-interior', caption: 'Interior restored after a break-in, before the new glass is installed', note: 'Same vehicle, finished.' },
    ],
    faqs: [
      { q: 'Do you replace car windows?', a: 'No. Glass replacement is done by a glass shop. We remove the broken glass from the interior, repair the damage the break caused and coordinate with the installer you or your insurer choose.' },
      { q: 'Why not just vacuum the glass myself?', a: 'You can get the big pieces, but tempered glass spreads into seat tracks, door panels, vents and under the carpet, and a household vacuum will not survive it. Fragments left behind come out of the vents for months and cut hands and upholstery.' },
      { q: 'Should the cleanup happen before or after the new glass?', a: 'Before is better, so the installer is not sealing new glass over a dirty channel and nothing gets trapped behind the new trim. We schedule around the glass appointment.' },
      { q: 'Will insurance pay for the cleanup?', a: 'When the glass broke in a covered event such as a break-in, the related interior cleanup and repair is usually part of the same claim, but your insurer decides. Our itemized estimate explains each line so the adjuster can see what was needed.' },
    ],
    related: ['car-vandalism-repair', 'insurance-auto-repair', 'car-water-damage'],
    ctaLabel: 'Request a cleanup estimate',
  },
]

export const pageBySlug = (slug: string): LandingPage | undefined => PAGES.find((p) => p.slug === slug)
