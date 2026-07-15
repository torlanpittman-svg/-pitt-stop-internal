# Pitt Stop OS — Module 2: Retail AI Estimator
## Product Requirements Document

---

## Document Control

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Status** | Draft |
| **Module** | 2 |
| **Last Updated** | 2026-07-14 |
| **Authors** | Pitt Stop Engineering & Product |
| **Classification** | Internal — Product Specification |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Product Vision](#2-product-vision)
3. [Business Goals](#3-business-goals)
4. [Product Philosophy](#4-product-philosophy)
5. [Users](#5-users)
6. [User Stories](#6-user-stories)
7. [Complete User Workflow](#7-complete-user-workflow)
8. [Photo Capture System](#8-photo-capture-system)
9. [AI Vision System](#9-ai-vision-system)
10. [Labor Estimation Engine](#10-labor-estimation-engine)
11. [Pricing Philosophy](#11-pricing-philosophy)
12. [Vehicle Size Modifiers](#12-vehicle-size-modifiers)
13. [Interior Condition Scoring](#13-interior-condition-scoring)
14. [Time Trap Detection](#14-time-trap-detection)
15. [AI Recommendation Output](#15-ai-recommendation-output)
16. [Employee Review Screen](#16-employee-review-screen)
17. [Learning System](#17-learning-system)
18. [Analytics Dashboard](#18-analytics-dashboard)
19. [Customer Experience](#19-customer-experience)
20. [Database Schema](#20-database-schema)
21. [API Architecture](#21-api-architecture)
22. [UI Wireframes](#22-ui-wireframes)
23. [Integrations](#23-integrations)
24. [Security](#24-security)
25. [Acceptance Tests](#25-acceptance-tests)
26. [Future Roadmap](#26-future-roadmap)
27. [Estimator Intelligence — Long-Term Vision](#27-estimator-intelligence--long-term-vision)
28. [Implementation Roadmap](#28-implementation-roadmap)
29. [Design Decisions](#29-design-decisions)
30. [Future Ideas — Parking Lot](#30-future-ideas--parking-lot)

---

## 1. Executive Summary

Pitt Stop OS Module 2 is a mobile-first AI-powered estimating system for retail auto detailing and repair services. It replaces the current process — which relies on employee experience, mental math, and tribal knowledge — with a structured, data-driven workflow that produces consistent, profitable estimates in under sixty seconds.

An employee photographs a customer's vehicle from a defined set of angles. The AI analyzes those photos and returns a complete estimate: detected conditions, estimated labor time for each finding, recommended selling price, risk flags, and suggested upsells. The employee reviews the AI output, makes corrections if needed, approves the estimate, and sends it to the customer.

Every AI prediction is preserved permanently alongside the final employee-confirmed value. Over time this creates a proprietary training dataset that improves prompt accuracy, informs pricing rules, and eventually enables model fine-tuning specific to Pitt Stop's vehicles, customers, and technician performance.

The module integrates with the existing Pitt Stop OS architecture and plugs into the home page as a standalone module. It is designed from day one to later connect to QuickBooks, AutoLeap, CRM, and scheduling systems without requiring database redesign.

---

## 2. Product Vision

Today, a Pitt Stop employee walks around a car, forms a mental picture, and quotes a number from memory. The accuracy of that number depends entirely on who is working that day. An experienced estimator builds intuition over years. A new employee underprices hard jobs, frustrates technicians, and erodes margin. Customers who get inconsistent quotes lose trust.

The Retail AI Estimator exists to encode Pitt Stop's collective expertise into a system that any employee can use on their first day. It is not a replacement for experienced judgment — it is an amplifier of it. The AI surfaces what an expert eye would catch. The employee confirms, adjusts, and owns the final number.

At its ceiling, this system becomes a competitive advantage. Pitt Stop's estimating data — tens of thousands of jobs, conditions, corrections, and outcomes — becomes a proprietary asset that no competitor can replicate. The estimator learns which types of vehicles consistently run over, which customers prefer premium services, which conditions the AI miscategorizes, and which upsells close most often. It eventually advises, not just calculates.

The north star: **a customer walks in, an employee photographs the vehicle, and a professional estimate is in the customer's hands within two minutes.**

---

## 3. Business Goals

### Primary Goals

**G1 — Estimate Speed**
Reduce the time from customer arrival to estimate delivery from an average of 5–10 minutes to under 2 minutes for standard vehicles.

**G2 — Estimate Consistency**
Eliminate price variance caused by employee experience level. Two different employees photographing the same vehicle should produce estimates within 10% of each other.

**G3 — Margin Protection**
Eliminate systematic underpricing of difficult jobs. Time traps — pet hair, sand, smoke, third rows — must be detected and priced before the job begins, not discovered mid-job.

**G4 — Average Ticket Growth**
Increase average estimate value through structured upsell recommendations. The AI should suggest higher-tier services when conditions and vehicle profile support them.

**G5 — Close Rate**
Right-priced estimates close more often than overpriced ones. The system should help employees find the price that maximizes both revenue and customer approval.

**G6 — Learning Data Asset**
Every estimate creates a labeled training record. Within twelve months, Pitt Stop should have enough proprietary data to measure AI accuracy precisely and begin prompt optimization cycles.

### Secondary Goals

**G7 — Technician Prep**
Approved estimates should flow to the shop floor with enough detail that technicians know what to expect before they open a car door.

**G8 — Customer Trust**
A professional, branded digital estimate signals quality and builds customer confidence before work begins.

**G9 — Integration Foundation**
The data model must support future QuickBooks invoicing, AutoLeap repair orders, CRM customer histories, and appointment scheduling without schema redesign.

### Success Metrics

| Metric | Baseline | 90-Day Target | 12-Month Target |
|--------|----------|---------------|-----------------|
| Estimate creation time | 5–10 min | < 2 min | < 90 sec |
| Employee-to-employee price variance | Unknown | < 15% | < 10% |
| Time trap detection rate | 0% (no system) | > 70% | > 90% |
| Customer estimate acceptance rate | Unknown | Measured | +10% vs baseline |
| AI field accuracy (condition codes) | N/A | Baseline established | > 80% |
| Average estimate value | Measured at launch | +5% | +15% |

---

## 4. Product Philosophy

This section governs every decision made during design and implementation. Any feature that does not serve this philosophy should be questioned.

### The Estimator Is Not a Dirt Detector

The most important constraint: **the AI must never simply return "dirty" or "clean."** Those words mean nothing to a business. They cannot be priced. They cannot be scheduled. They cannot be communicated to a technician.

The AI must translate visual observations into business consequences. Not "there is pet hair" but "pet hair covering 60% of rear seating requires approximately 45 additional minutes and increases job difficulty from routine to moderate." Every finding must have a labor consequence.

### What the Estimator Actually Estimates

The six dimensions of every estimate:

**1. Labor Required**
The honest answer to "how long will this take?" Broken into base time (by service type and vehicle size) plus additive time contributions from every condition found. This is the foundation everything else is calculated from. A wrong labor number produces a wrong price.

**2. Difficulty**
Not every 90-minute job is equally difficult. Vacuuming a clean minivan for 90 minutes is routine. Removing sand and pet hair from a full-size SUV for 90 minutes is exhausting and error-prone. Difficulty affects which technician should be assigned, whether the job can be turned around same-day, and whether the quoted price is worth taking. Difficulty is rated: `routine`, `moderate`, `demanding`, `time_trap`.

**3. Profitability**
Every estimate must clearly show whether the job makes money at the quoted price. Labor cost (hours × technician rate), materials estimate, overhead contribution, and margin percentage are calculated automatically. An estimate that would produce negative margin must be flagged before it is quoted to the customer.

**4. Customer Value**
The same service on a $4,000 car is priced differently than on an $85,000 car. Customers who drive luxury vehicles have higher standards, expect premium outcomes, and have accepted higher prices in the rest of their lives. The estimator should consider vehicle class when determining where in the price range to quote.

**5. Probability of Closing**
Not every estimate should be priced the same way. A customer who drove thirty minutes to a specialized detailing shop is more likely to approve than a walk-in comparing prices on their phone. A repeat customer who has paid Pitt Stop's prices before is more likely to approve than a first-time customer. The estimator should surface factors that inform the employee's pricing decision — not make the decision for them, but inform it.

**6. Recommended Selling Price**
A specific number. Not a formula, not a range by itself — a recommendation. The recommended price should be the number that maximizes the combination of margin and close probability for this specific customer and vehicle. The price range provides context. The recommendation is what the employee uses as their starting point.

### Every Architectural Decision Serves This Philosophy

- The database stores labor estimates, difficulty ratings, and margin calculations — not just line item descriptions.
- The AI prompt instructs on labor minutes per finding, not just condition names.
- The review screen shows the employee exactly what is contributing to labor and cost.
- The learning system tracks not just "was the AI right?" but "was the labor estimate right, and did the technician agree?"
- The analytics dashboard shows margin per job, not just revenue.

### Design Principles

**Principle 1 — Speed Over Completeness**
A fast good estimate closes more business than a perfect estimate delivered too late. The flow must be optimized for speed. Every extra tap costs money.

**Principle 2 — AI Suggests, Employee Decides**
The AI is never the final authority. The employee can override any field at any time without being prompted to justify it. The system records the correction silently and learns from it. There are no warnings that the employee is "overriding AI."

**Principle 3 — Immutable AI Originals**
The AI's original prediction for every field is written once and never overwritten. The employee sees and works with the confirmed value, but the original is preserved in the database forever. This is not optional — it is the source of the module's intelligence over time.

**Principle 4 — Profitable by Default**
The system's default pricing should produce a profitable outcome without any employee input. If the AI is calibrated correctly, an employee who accepts all AI recommendations should have a healthy margin. Corrections should make the estimate more accurate, not just cheaper.

**Principle 5 — Mobile First, Always**
Every screen is designed for a phone held in one hand while standing next to a car in a parking lot. No table-heavy layouts. No small touch targets. No requiring the employee to type when they can tap.

---

## 5. Users

### 5.1 Employee (Estimator)

**Who they are:** A Pitt Stop team member who greets customers, photographs vehicles, reviews AI output, makes corrections, and delivers estimates. They may or may not have formal detailing experience. Some are new hires. All are using phones.

**Their goals:**
- Get through the estimate quickly so the customer doesn't wait
- Quote the right price — not too low (lost margin), not too high (lost sale)
- Not think hard about pricing decisions under pressure
- Avoid confrontation with customers about why the price is what it is

**Their workflow:**
1. Customer arrives and describes what they want (or the employee assesses and recommends)
2. Employee opens Pitt Stop OS → Retail Estimator on phone
3. Photographs vehicle using guided camera flow
4. Reviews AI output, adjusts if needed
5. Shows or sends estimate to customer
6. Records customer decision (approved or declined)

**What they need from the system:**
- A recommendation they can stand behind immediately
- Visual feedback that the AI saw what they saw
- Easy correction when the AI missed something
- A professional-looking output to hand to the customer

**Pain points today:**
- Mental math under pressure produces inconsistent quotes
- New employees underprice hard jobs because they don't recognize time traps yet
- There is no record of what was quoted or why

---

### 5.2 Manager

**Who they are:** A senior team member or shift lead who oversees estimate quality, handles customer escalations, reviews jobs before they start, and monitors performance metrics.

**Their goals:**
- Ensure jobs are priced to make money
- Catch underpriced time trap jobs before technicians start them
- Monitor estimate accuracy and coach employees who consistently under/over-estimate
- Override prices when business circumstances justify it (VIP customer, slow day, competitor match)

**Their workflow:**
1. Reviews pending estimates in the admin dashboard
2. Approves, adjusts, or flags estimates before customer is notified
3. Reviews AI learning reports weekly to identify systematic errors
4. Adjusts pricing catalog when costs change
5. Handles customer disputes about price

**What they need from the system:**
- Clear visibility into every estimate and what drove the price
- The ability to adjust prices without disrupting the customer experience
- Metrics on which employees quote accurately vs. which need coaching
- Ability to flag estimates that need their review before being sent

---

### 5.3 Owner

**Who they are:** The business owner who is ultimately accountable for revenue, margin, and growth. May not be on-site daily. Wants data, not detail.

**Their goals:**
- Understand whether estimates are translating to revenue
- Know whether the pricing strategy is working
- Identify which service types are most profitable
- Make informed decisions about pricing catalog changes

**Their workflow:**
1. Reviews business dashboard weekly (estimates created, revenue, margin, close rate)
2. Reviews monthly trends in average ticket value and technician utilization
3. Makes pricing catalog decisions based on margin data
4. Evaluates AI accuracy improvement over time as a proxy for system health

**What they need from the system:**
- Business-level KPIs, not per-estimate detail
- Revenue by service category
- Margin trends over time
- Close rate by price range (to calibrate pricing strategy)

---

### 5.4 Customer (Milestone 3 and beyond)

**Who they are:** The vehicle owner who receives the estimate and decides whether to proceed.

**Their goals:**
- Understand exactly what they're paying for
- Trust that the price is fair
- Approve conveniently without needing to be physically present
- Know when the job will be done

**Their workflow (future):**
1. Receives a text or email with a link to their estimate
2. Views a professional, branded summary of findings and recommended services
3. Taps "Approve" or "Decline"
4. Optionally selects an appointment time
5. Receives confirmation

**What they need from the system:**
- Plain language descriptions of what was found (no technical jargon)
- Visual evidence from their vehicle photos
- Clear total cost
- Easy approval mechanism

---

## 6. User Stories

### Employee Stories

- **US-001** — As an employee, I want to photograph a vehicle from a guided sequence of angles so that I capture every part of the vehicle the AI needs to make an accurate assessment.
- **US-002** — As an employee, I want the AI to identify conditions I might have missed on a visual walkthrough so that my estimate is accurate even when I am new or working quickly.
- **US-003** — As an employee, I want to see a recommended selling price immediately after photos are processed so that I can quote the customer without mental math.
- **US-004** — As an employee, I want to see the AI's reasoning for each finding so that I can explain the price to the customer in plain language.
- **US-005** — As an employee, I want to adjust any AI recommendation before presenting it to the customer so that I remain in control of what I quote.
- **US-006** — As an employee, I want the system to flag time traps automatically so that I never unknowingly quote a difficult job at a routine price.
- **US-007** — As an employee, I want to add a condition the AI missed so that my estimate reflects everything I observed.
- **US-008** — As an employee, I want to see which upsells the AI recommends for this vehicle so that I have a natural conversation starter for premium services.
- **US-009** — As an employee, I want to send the estimate directly to the customer's phone so that they can review and approve without me having to stand with them.
- **US-010** — As an employee, I want to record whether the customer approved or declined so that the business has a complete record of every estimate.
- **US-011** — As an employee, I want to retake any photo that came out blurry or poorly lit so that the AI has good data to work with.
- **US-012** — As an employee, I want to complete the entire estimate flow with one hand so that I can hold a key fob or clipboard in the other.

### Manager Stories

- **US-013** — As a manager, I want to see all pending estimates that have not yet been sent to a customer so that I can review them before they go out.
- **US-014** — As a manager, I want to override the price on any estimate and record a reason so that my adjustment is tracked and the employee understands the decision.
- **US-015** — As a manager, I want to see a flag on estimates that are priced below the minimum acceptable margin so that I catch underpriced jobs before work begins.
- **US-016** — As a manager, I want to see which employees consistently produce accurate estimates versus which require correction so that I can target coaching.
- **US-017** — As a manager, I want to update a service's base price in the pricing catalog and have it apply to all future estimates immediately so that price changes take effect without a deployment.
- **US-018** — As a manager, I want to view the complete history of any estimate including the original AI prediction and every change made to it so that I have a full audit trail.
- **US-019** — As a manager, I want to see the AI's detection accuracy broken down by condition type so that I know which areas of the prompt need improvement.

### Owner Stories

- **US-020** — As an owner, I want to see total revenue, average ticket value, and close rate for any time period so that I can monitor business health without reviewing individual estimates.
- **US-021** — As an owner, I want to see margin by service category so that I can identify which services are most profitable and make strategic decisions about what to promote.
- **US-022** — As an owner, I want to see the AI accuracy trend over time so that I can evaluate whether the learning investment is producing results.
- **US-023** — As an owner, I want to see which vehicle types and conditions consistently run over the estimated labor so that I can adjust pricing to protect margin.

### Customer Stories (Future — Milestone 3)

- **US-024** — As a customer, I want to receive my estimate on my phone so that I can review it without waiting at the shop.
- **US-025** — As a customer, I want to see photos of my vehicle alongside the findings so that I understand what I'm paying for.
- **US-026** — As a customer, I want to approve or decline with a single tap so that the process is convenient.
- **US-027** — As a customer, I want to see a breakdown of each service and what it costs so that the price feels transparent.

---

## 7. Complete User Workflow

### Phase 0 — Customer Arrival

Customer walks in or calls ahead. The employee greets the customer and asks one question: "Are you interested in detailing, paint correction, or any specific repairs today?" The answer informs which service category to focus on during estimation, but the AI will identify needs across all categories regardless of what the customer asks for.

The employee does NOT attempt to visually assess the vehicle before photographing it. They open the app immediately.

---

### Phase 1 — Estimate Initiation

**Screen: Estimator Landing**
Employee taps "Create Retail Estimate" from the Pitt Stop OS home screen.

**Screen: Service Focus (optional, one tap)**
The employee optionally selects a primary intent: Interior Detail / Exterior Detail / Full Detail / Paint Correction / Paint Repair / Ceramic Coating / PPF / Window Tint / Other (Let AI Decide).

This selection does not constrain the AI. It informs the AI's prioritization.

---

### Phase 2 — Vehicle Information (Light Intake)

**Screen: Quick Vehicle Info**

The employee enters:
- Customer name (required)
- Customer phone (required)
- Vehicle type (compact / sedan / mid-size SUV / full-size SUV / minivan / truck — icons, not text)
- Vehicle year and make/model (optional — AI will identify from photos)

---

### Phase 3 — Photo Capture

**Screen: Guided Multi-Photo Capture**

- 4 required photos: driver side, passenger side, front, rear
- 2 optional recommended: interior overview, open trunk
- Unlimited damage/condition close-ups
- "Analyze Vehicle" activates after 2 required photos are captured

**Transition: Analysis in Progress**
Full-screen loading state. Message: "AI reading your vehicle…" Estimated time shown. Abort option available.

---

### Phase 4 — AI Review

**Screen: Estimate Review**

Vehicle confirmation card at top (editable). Findings list ordered by severity descending. Time trap warnings if detected. Suggested upsells below findings. Sticky footer: total labor, recommended price, confidence indicator, Adjust / Approve buttons.

---

### Phase 5 — Correction (If Needed)

**Screen: Edit Mode**

Employee taps any finding to edit severity, change service type, or mark not found. Taps "+ Add Finding" for AI misses. Overrides final price directly. All changes recorded alongside original AI values.

---

### Phase 6 — Approval

**Screen: Approve Estimate**

Summary: customer, vehicle, service list, total, estimated completion time. Manager approval gate if threshold exceeded. Employee taps "Approve" → status: `approved`.

---

### Phase 7 — Delivery

**Screen: Send Estimate**

Options: SMS, Show on Screen, Copy Link, Email. Employee selects and sends.

---

### Phase 8 — Customer Decision

Customer opens estimate link. Sees: branding, vehicle photos, services in plain language, total. Taps Approve or Decline. Status updates immediately. Employee notified.

---

### Phase 9 — Job Execution and Close

Approved estimate appears in shop's job queue. Integration with AutoLeap (Milestone 5) pushes repair order automatically. On completion, converts to QuickBooks invoice.

---

### Phase 10 — Learning

After each completed job: AI original prediction, employee corrections, final price, customer decision, and technician time (Milestone 4) are all stored. These feed the AI Learning dashboard.

---

## 8. Photo Capture System

### 8.1 Required Photos

**Slot 1 — Driver Side Full View**
Position: 8–12 feet from vehicle at 90-degree angle. Full vehicle from bumper to bumper visible. Captures: exterior paint, door panels, rocker panels.
- Good: Full side visible, even lighting, no harsh shadows
- Bad: Partial view, standing too close, reflections obscuring panels

**Slot 2 — Passenger Side Full View**
Mirror of driver side. Often reveals different condition (curb rash, door dings from passenger egress).

**Slot 3 — Front View**
Position: Directly centered, 8–10 feet back. Full bumper to roof visible. Captures: bumper condition, grille, headlights, license plate.

**Slot 4 — Rear View**
Position: Directly centered behind vehicle, 8–10 feet back. Captures: rear bumper, tailgate, trunk, hitch, exhaust tips.

### 8.2 Optional Recommended Photos

**Slot 5 — Interior Overview** (Recommended for all vehicles)
Open driver door, capture front seats, rear seats, and dash in one wide shot.

**Slot 6 — Rear Interior / Third Row** (Mandatory for SUVs and minivans)
System auto-prompts when vehicle type has three rows. Captures: third-row condition, pet hair concentration, rear carpet.

**Slot 7 — Open Trunk** (Optional)
Trunk liner condition, spare tire well (common sand accumulation trap).

### 8.3 On-Demand Close-Up Photos (Unlimited)

Tagged by location and linked to specific findings in AI output. Serve as documentation and higher-quality training data for specific conditions.

### 8.4 Camera Guidance System

**Before capture:** Illustrated silhouette of correct framing. Real-time blur and lighting indicator.

**During capture:** Semi-transparent car silhouette overlay. Guide outline turns green when alignment is acceptable. Tap shutter or auto-capture on alignment.

**After capture:** Full-screen preview. "Use This" triggers quality check. Blur detected → warning with Retake (primary) / Use Anyway (secondary). Choice recorded.

### 8.5 Quality Gates (Enforced)

- Minimum resolution: 1280 × 960 pixels after any crop
- Blur detection: configurable threshold; warning shown above threshold
- Vehicle coverage: vehicle must occupy ≥ 40% of frame for overview shots
- Lighting: bright direct sun on shiny surfaces flagged with advisory

### 8.6 Upload Strategy

Photos held as File objects in browser until "Analyze Vehicle" is tapped.

1. Client resizes each photo to max 2048px (canvas API, JPEG quality 0.88)
2. All photos uploaded in single multipart POST to `/api/estimator/analyze`
3. Server writes to Vercel Blob in parallel
4. Creates `estimate` and `estimate_photos` records
5. Sends all photos to AI in single GPT-4o vision request
6. Parses response into `estimate_line_items`
7. Returns `{ estimateId }` → client redirects to review screen

---

## 9. AI Vision System

### 9.1 What the AI Must Analyze

All overview photos sent simultaneously in a single GPT-4o vision request.

**Vehicle Identification:** Year, make, model, color, license plate (display only), value tier (economy / mid-market / premium / luxury / exotic), age estimate, vehicle size category.

**Exterior Paint and Panels (per panel):** Scratch presence and size, dent presence, paint oxidation, water spots, swirl marks, paint chips, clear coat failure, rust.

**Exterior Glass:** Windshield (chips, cracks, bug accumulation), rear window, side windows, sunroof.

**Wheels and Tires:** Wheel condition, brake dust, curb rash, damage; tire sidewall condition.

**Interior Condition (from interior photos):** Organization level, seat surface condition, pet hair (presence, coverage, surfaces), food debris, drink stains, dust, carpet condition, headliner, door panels, floor mats, child seat presence.

**Time Traps:** Identified as a separate category. Every time trap is surfaced as a distinct finding with a red severity designation. Non-negotiable.

### 9.2 What the AI Must NOT Do

- Summarize as "dirty" or "clean" without specifics
- Return a dollar price
- Determine whether to accept or decline the job
- Make assumptions about what the customer wants
- Skip minor conditions — every condition is surfaced; employee decides what to include

### 9.3 AI Output Format

```json
{
  "vehicle": {
    "year": "2019",
    "make": "Chevrolet",
    "model": "Tahoe",
    "color": "Black",
    "licensePlate": "ABC1234",
    "valueTier": "mid-market",
    "ageEstimate": "mid-age",
    "vehicleSize": "full_size_suv",
    "hasThirdRow": true,
    "hasSunroof": true,
    "confidence": {
      "year": 0.72,
      "make": 0.95,
      "model": 0.91,
      "color": 0.99,
      "vehicleSize": 0.98
    }
  },
  "findings": [
    {
      "id": "f1",
      "category": "time_trap",
      "subcategory": "pet_hair",
      "location": "interior_rear_seats",
      "severity": "heavy",
      "description": "Dense dog hair covering approximately 80% of rear seat fabric and visible on carpet",
      "serviceCode": "pet_hair_heavy",
      "laborMinutes": 75,
      "confidence": 0.91,
      "photoIndex": 4,
      "requiresManagerAlert": true
    }
  ],
  "timeTrapSummary": {
    "detected": true,
    "traps": ["pet_hair_heavy"],
    "estimatedExtraMinutes": 75,
    "difficultyRating": "demanding"
  },
  "laborSummary": {
    "baseMinutes": 150,
    "conditionMinutes": 105,
    "totalMinutes": 255,
    "difficultyRating": "demanding"
  },
  "upsellSuggestions": [
    {
      "serviceCode": "ceramic_coat_basic",
      "rationale": "Black vehicle with moderate oxidation. Ceramic coating would protect the corrected finish.",
      "probability": "medium"
    }
  ],
  "notes": "Vehicle has multiple time traps. Third row present. Recommend confirming same-day turnaround with customer.",
  "promptVersion": "v1",
  "modelName": "gpt-4o-2024-11-20"
}
```

### 9.4 Prompt Architecture

**System prompt** (injected fresh at each request, includes current catalog codes):

> You are a professional auto detailing and repair estimator for Pitt Stop. You receive vehicle photos and produce a structured damage and condition assessment.
>
> Your role is NOT to describe what you see in plain terms. Your role is to identify business-relevant findings: labor consequences, time traps, difficulty ratings, and recommended services.
>
> CRITICAL RULES:
> 1. Every finding must include an estimated labor contribution in minutes.
> 2. Time traps must be identified as a separate category and flagged.
> 3. You must never return a dollar amount. Prices are handled separately.
> 4. Use only the following service codes: [dynamically injected from pricing_catalog]
> 5. Use only the following location codes: [standardized location taxonomy]
> 6. Return valid JSON only. No markdown, no explanation outside the JSON structure.

**Severity guide injected into prompt:**
- `light`: Adds < 15 minutes to a base service
- `moderate`: Adds 15–45 minutes to a base service
- `heavy`: Adds 45+ minutes; may require specialized techniques

### 9.5 Prompt Versioning

Constant `ESTIMATOR_PROMPT_VERSION` in `apps/estimator/ai/index.ts` bumped with every prompt template change. Stored on every estimate. AI Learning dashboard groups accuracy metrics by prompt version for before/after comparison.

### 9.6 Catalog Injection Strategy

Current active catalog codes are loaded from `pricing_catalog` at analysis time and injected into the system prompt. This means:
- Admin can add new service codes without changing the prompt template
- The AI never sees prices
- New codes automatically become available to the AI on next request

### 9.7 Location Taxonomy (Standardized)

```
front_bumper_left, front_bumper_center, front_bumper_right
front_hood, front_grille, front_headlight_left, front_headlight_right
driver_door_front, driver_door_rear, driver_fender, driver_rocker_panel
passenger_door_front, passenger_door_rear, passenger_fender, passenger_rocker_panel
rear_bumper_left, rear_bumper_center, rear_bumper_right
rear_trunk, rear_tailgate, rear_taillight_left, rear_taillight_right
roof, windshield, rear_window, driver_window, passenger_window
wheel_driver_front, wheel_driver_rear, wheel_passenger_front, wheel_passenger_rear
interior_dashboard, interior_seats_front, interior_seats_rear, interior_seats_third
interior_carpet_front, interior_carpet_rear, interior_headliner
interior_console, interior_door_panels, interior_glass
```

---

## 10. Labor Estimation Engine

This is the technical heart of the module. Every recommendation traces back to a labor number.

### 10.1 Architecture

The labor estimation engine is a server-side calculation layer. The AI provides conditions and severity; the engine applies deterministic rules to convert them into minutes.

```
AI Findings
    ↓
[Labor Estimation Engine]
    ↓
Base Minutes (by service type)
    × Vehicle Size Modifier (%)
    + Condition Modifier Minutes (per finding, per severity)
    + Time Trap Surcharge Minutes
    ─────────────────────────────
    = Total Estimated Minutes
    ÷ 60 = Total Hours
    × Target Hourly Rate
    ─────────────────────────────
    = Labor Cost
    + Materials Estimate
    × Markup Multiplier
    ─────────────────────────────
    = Recommended Selling Price
```

### 10.2 Base Labor Times by Service

Times represent a compact vehicle in clean but normal condition.

| Service Code | Service Name | Base Minutes |
|---|---|---|
| `interior_basic` | Interior Vacuum + Wipe | 45 |
| `interior_full` | Full Interior Detail | 90 |
| `interior_deep` | Deep Interior Detail | 150 |
| `exterior_wash` | Exterior Wash Only | 20 |
| `exterior_wash_wax` | Wash + Hand Wax | 55 |
| `exterior_full` | Full Exterior Detail | 90 |
| `full_detail_basic` | Full Detail (Basic) | 150 |
| `full_detail_standard` | Full Detail (Standard) | 180 |
| `full_detail_premium` | Full Detail (Premium) | 270 |
| `paint_correction_one` | Paint Correction 1-Stage | 180 |
| `paint_correction_two` | Paint Correction 2-Stage | 300 |
| `paint_correction_three` | Paint Correction 3-Stage | 480 |
| `ceramic_coat_basic` | Ceramic Coating (Basic) | 240 |
| `ceramic_coat_pro` | Ceramic Coating (Pro) | 360 |
| `ppf_partial` | PPF Partial | 180 |
| `ppf_full_front` | PPF Full Front | 300 |
| `ppf_full_vehicle` | PPF Full Vehicle | 720 |
| `wheel_clean_full` | Wheel & Tire Detail (set of 4) | 40 |
| `wheel_refinish` | Wheel Refinish (each) | 90 |
| `windshield_chip` | Windshield Chip Repair (each) | 30 |

### 10.3 Interior Condition Modifiers

Applied additively on top of base interior service time. Modifiers compound.

| Condition | Light (min) | Moderate (min) | Heavy (min) | Notes |
|---|---|---|---|---|
| Pet hair — seats | +10 | +25 | +50 | Per seating row |
| Pet hair — carpet | +10 | +20 | +40 | Full carpet |
| Pet hair — headliner | +15 | +30 | +50 | Especially difficult |
| Sand — carpet | +10 | +25 | +45 | Requires extraction cycles |
| Sand — seat crevices | +5 | +15 | +30 | Hard to remove completely |
| Food debris / crumbs | +5 | +15 | +30 | Under seats multiplies time |
| Drink stains — fabric | +15 | +25 | +40 | Set stains harder |
| Drink stains — leather | +10 | +20 | +35 | Risk of damage to leather |
| Coffee spill (recent) | +15 | — | — | Single severity |
| Coffee spill (set) | — | +25 | — | Sugars bond with fabric |
| General trash / clutter | +5 | +10 | +20 | Must sort before cleaning |
| Dust — dash/surfaces | +5 | +10 | +20 | Vent cleaning drives up time |
| Sticky residue | +15 | +30 | +50 | Requires solvent, multiple passes |
| Odor treatment | +20 | +35 | +60 | Includes product application time |
| Smoke saturation | +30 | +50 | +90 | Full ozone or fogging required |
| Vomit / biohazard | +45 | +75 | — | Protective equipment required |
| Mold | +60 | — | — | Specialist service; escalate |
| Glitter | +30 | +60 | — | Near-impossible to fully remove |
| Child seat presence | +10 | — | — | Remove, clean under, reinstall |
| Third row — present | +15 | — | — | Baseline for vehicle type |
| Headliner staining | +10 | +25 | +45 | Delicate surface; slower work |
| Leather conditioning | +15 | — | — | Per row with cracking |
| Carpet shampoo | +20 | — | — | Full extraction + dry time |

### 10.4 Exterior Condition Modifiers

| Condition | Light (min) | Moderate (min) | Heavy (min) |
|---|---|---|---|
| Bugs on front/bumper | +5 | +15 | +25 |
| Water spots | +10 | +25 | +45 |
| Tree sap | +10 | +20 | +40 |
| Tar / asphalt | +10 | +25 | +40 |
| Brake dust — wheels | +5 | +10 | +20 |
| Oxidation — paint | +15 | +35 | +60 |
| Swirl marks | +20 | +45 | +90 |
| Clear coat failure | — | +45 | +90 |
| Scratches — per panel | +10 | +30 | +60 |
| Dents — per dent (PDR) | +15 | +35 | +75 |
| Conventional dent repair | — | +90 | +180 |
| Rail dust | +15 | +30 | +60 |
| Fallout / industrial | +20 | +45 | +90 |
| Mud accumulation | +10 | +25 | +45 |
| Wheel well buildup | +10 | +20 | +35 |

### 10.5 Labor Cost Calculation

```
Total Minutes = (Base Minutes × Vehicle Size Multiplier)
              + Σ (Condition Modifier Minutes)

Total Hours = Total Minutes ÷ 60

Labor Cost = Total Hours × Target Hourly Rate (from estimator_config)
```

### 10.6 Materials Estimation

| Category | Materials as % of Labor |
|---|---|
| Interior detail | 8% |
| Interior with odor treatment | 15% |
| Exterior wash and wax | 10% |
| Paint correction | 12% |
| Ceramic coating | 25% |
| PPF | 40% |
| Scratch repair | 15% |

Percentages stored in `estimator_config` and adjustable by admin.

### 10.7 Recommended Price Calculation

```
Base Cost = Labor Cost + Materials Estimate

Markup Multiplier (from estimator_config, e.g., 2.2×)

Recommended Price = Base Cost × Markup Multiplier

Price Range Low  = Recommended Price × 0.85
Price Range High = Recommended Price × 1.20

Luxury/Exotic Premium = +15% to Recommended Price
```

### 10.8 Margin Calculation (Admin Only)

```
Margin = (Final Approved Price − Base Cost) ÷ Final Approved Price × 100

Minimum Acceptable Margin (from estimator_config, e.g., 40%)

If Margin < Minimum → flag for manager review before sending
```

---

## 11. Pricing Philosophy

### 11.1 Pitt Stop's Pricing Framework

Pitt Stop does not charge a flat rate for services. Every vehicle is different. The same "full interior detail" on a compact sedan in moderate condition takes 90 minutes; the same service on a third-row SUV with heavy pet hair and beach sand takes 4 hours. Charging the same price for both is a business decision to lose money on hard jobs.

The estimator encodes this reality into a consistent, defensible pricing framework.

### 11.2 Customer Segments and Their Pricing

**Retail Customer (Standard)**
Full markup multiplier. Quote recommended price as the opening number. Do not discount without a reason. Upsell is appropriate when vehicle condition and value support it.

**Retail Customer (Repeat)**
Loyalty modifier: 5–8% off recommended price (configurable). Note repeat status in estimate. More willing to approve premium services if past experiences were positive. Employee selects "Repeat Customer" checkbox manually until CRM integration automates it.

**Dealer / Fleet**
Governed by a separate dealer agreement, not this estimator. This estimator is for retail only. If a dealer sends a vehicle for retail detailing outside of a batch, treat as retail customer.

**Luxury Vehicle**
Vehicle with AI-identified value tier of `luxury` or `exotic`. Apply luxury premium: +15% to recommended price. Documents rationale: higher customer expectations, higher risk of damage claims, premium products required. Applied automatically by AI tier detection; employee can remove.

**Vehicle in Very Poor Condition (High Time Trap)**
Total estimated labor exceeds 4 hours (configurable). Flag as high-complexity job. Require manager approval before sending. These jobs should not be committed to by an employee alone.

### 11.3 Minimum Acceptable Pricing

```
Minimum Acceptable Estimate = Base Cost ÷ (1 − Minimum Margin %)
```

If employee drops price below this floor, system shows: "This price may not be profitable. A manager can override if appropriate." System does not block the estimate — it informs.

### 11.4 Maximum Justified Pricing

```
Maximum Justified Price = Recommended Price × Maximum Premium Multiplier (default: 1.4×)
```

Estimates above this range show: "This estimate is at the upper range of expected pricing for this vehicle and service. Review before sending." System does not block — it informs.

### 11.5 Manager Overrides

A manager may override any price at any time. Override reasons (required):
- Competitor price match
- Customer loyalty exception
- Slow day / capacity fill
- Promotional period
- Error correction

Reason stored in estimate record, visible in admin, never shown to customer.

---

## 12. Vehicle Size Modifiers

Applied as multipliers to base service time before condition modifiers.

| Vehicle Category | Examples | Size Multiplier |
|---|---|---|
| Compact car | Honda Civic, Toyota Corolla, Mazda 3 | 1.00× (baseline) |
| Mid-size sedan | Toyota Camry, Honda Accord, Nissan Altima | 1.15× |
| Full-size sedan | Dodge Charger, Chrysler 300 | 1.20× |
| Coupe | Mustang, Camaro, BMW 4-series | 1.10× |
| Compact SUV / crossover | Toyota RAV4, Honda CR-V, Ford Escape | 1.25× |
| Mid-size SUV | Toyota Highlander, Ford Explorer, Kia Telluride | 1.40× |
| Full-size SUV (2-row) | Tahoe, Expedition (no 3rd row) | 1.50× |
| Full-size SUV (3-row) | Tahoe (3rd row), Expedition Max, Escalade | 1.60× |
| Minivan | Honda Odyssey, Toyota Sienna, Pacifica | 1.55× |
| Compact pickup | Ford Maverick, Honda Ridgeline | 1.30× |
| Full-size pickup (standard cab) | F-150 regular cab | 1.35× |
| Full-size pickup (crew cab) | F-150 SuperCrew, Ram 1500 Crew Cab | 1.45× |
| Heavy-duty pickup | F-250/F-350, Ram 2500/3500 | 1.55× |
| Work truck (any) | Any truck with work bed or tool boxes | Above multiplier +20% |
| Sports car | Porsche 911, Corvette, Ferrari | 1.10× + luxury premium |
| Luxury sedan | Mercedes E-Class, BMW 5-series, Audi A6 | 1.15× + luxury premium |
| Full-size luxury SUV | Cadillac Escalade, Lincoln Navigator | 1.65× + luxury premium |
| Exotic | Lamborghini, Ferrari, McLaren, Rolls-Royce | Escalate to owner |
| Cargo van / commercial | Sprinter, Transit | 1.70× |
| Convertible | Any make | 1.15× + soft top care note |

The AI identifies vehicle size category. Employee can correct it from the review screen (triggers recalculation).

---

## 13. Interior Condition Scoring

Interior scored on a 5-point scale per category. AI assigns scores; employee can adjust.

### Scoring Scale

| Score | Label | Meaning |
|---|---|---|
| 1 | Excellent | Appears unused or recently professionally cleaned |
| 2 | Good | Normal daily use, minor dust, no stains |
| 3 | Fair | Visible dirt, dust, moderate crumbs, minor staining |
| 4 | Poor | Heavy soiling, staining, or a specific time trap present |
| 5 | Critical | Biohazard, mold, extreme pet hair, smoke saturation |

### Category Scoring Detail

**Seats (Fabric)** — Labor: Score × 12 min per row
- 1: No debris, no staining
- 2: Light dust, minor crumbs in crevices
- 3: Visible staining, embedded crumbs, pet hair (light)
- 4: Heavy staining, moderate-to-heavy pet hair, food debris
- 5: Biohazard, mold, or extreme pet hair

**Seats (Leather)** — Labor: Score × 10 min per row
- 1: No cracking, no staining, recently conditioned
- 2: Minor dust, slight surface dryness
- 3: Visible staining, mild cracking, needs conditioning
- 4: Significant cracking, staining, possible discoloration
- 5: Damaged leather, staining that may not reverse
- Score 4+ adds "risk of damage" warning

**Carpet and Floor Mats** — Labor: Score × 18 min (full carpet)
- 1: Clean, no debris
- 2: Light dirt, normal shoe traffic
- 3: Visible dirt, crumbs, light staining
- 4: Heavy soiling, staining, pet hair, sand
- 5: Sand saturation, pet hair embedded, or biohazard

**Dashboard and Hard Surfaces** — Labor: Score × 8 min
**Cup Holders and Console** — Labor: Score × 6 min
**Headliner** — Labor: Score × 15 min; Score 4+ adds "delicate surface" risk warning
**Door Panels** — Labor: Score × 5 min (all 4 doors)
**Glass (Interior)** — Labor: Score × 4 min
**Odor** — Labor: Score × 15 min; Score 5 flagged as time trap, requires manager confirmation

### Composite Interior Score

Weighted average driving base service recommendation:
- Seats: 30%, Carpet: 25%, Dashboard: 15%, Console: 10%, Door panels: 8%, Headliner: 7%, Glass: 5%

| Score Range | Recommended Service |
|---|---|
| 1.0–1.8 | Basic interior vacuum and wipe (`interior_basic`) |
| 1.9–2.5 | Standard interior detail (`interior_full`) |
| 2.6–3.5 | Full interior detail + condition modifiers |
| 3.6–4.5 | Deep interior detail (`interior_deep`) |
| 4.6–5.0 | Critical — flag for manager |

---

## 14. Time Trap Detection

Time traps are conditions that dramatically increase labor beyond what vehicle size and surface area would predict. An estimate with any unacknowledged time trap cannot be approved without a manager override.

### Time Trap Catalog

| Condition | Detection Cues | Extra Labor | Difficulty | Notes |
|---|---|---|---|---|
| **Heavy Pet Hair** | Dense hair on seats/carpet/headliner | Light +25 / Mod +55 / Heavy +90–120 min | Demanding–Time Trap | Multiple vacuum passes; specialized tools; may need second technician |
| **Beach / Fine Sand** | Sandy texture on carpet and seat fabric | Light +15 / Mod +35 / Heavy +55 min | Moderate–Demanding | Embeds in carpet fibers; multiple extraction passes |
| **Construction Dust** | White/grey fine dust on all surfaces | +60–90 min | Time Trap | Permeates HVAC; filter replacement may be needed |
| **Glitter** | Sparkle visible on any surface | +45–90 min | Time Trap | Never fully removable; customer must be informed before accepting |
| **Smoke Saturation** | Yellow-brown headliner tint; glass film | +60–90 min + ozone | Demanding–Time Trap | Two ozone cycles minimum; results not guaranteed |
| **Vomit / Biological** | Visible biological material on seats/carpet | +60 min | Demanding | Biohazard protocol required; escalate to manager |
| **Mold** | Dark spotting on headliner or seat fabric | +90–180 min or specialist referral | Time Trap / Escalate | Antimicrobial treatment; may require headliner removal |
| **Milk / Formula (set)** | Spill pattern in rear seat area | +30–60 min | Demanding | Odor may persist; expectation management required |
| **Coffee / Energy Drink (set)** | Brown staining on seats, carpet, console | Light +15 / Mod +30 / Severe +50 min | Routine–Demanding | Sugars bond chemically with fabric over time |
| **Work Truck Interior** | Tool debris, adhesive, construction materials | +45–90 min | Demanding–Time Trap | May require solvents; standard equipment may not suffice |
| **Third-Row Access** | Three-row vehicle type | +20 min (mandatory) | — | Mandatory for any interior service |
| **Installed Car Seats** | Visible infant/child seats in photos | +15 min per seat | — | Must inform customer; document if removal declined |
| **White / Light Leather** | Light-colored upholstery | No time modifier | Risk flag | +$25 risk premium per row; results may vary on set staining |
| **Sunroof Tracks** | Sunroof panel visible in photos | +10 min | — | Drain channels frequently clogged |
| **Convertible Soft Top** | Fabric roof visible | +15 min | — | Specific products for vinyl vs. fabric |
| **Heavily Modified Interior** | Custom carpet, non-standard materials | +30 min (estimate basis) | — | Product compatibility must be confirmed before proceeding |

---

## 15. AI Recommendation Output

### 15.1 Recommendation Fields

**Recommended Price** — A single dollar figure. Displayed prominently. This is the suggested selling price, calculated by the pricing engine from AI findings. Not returned by the AI itself.

**Price Range** — Low (×0.85) and high (×1.20, adjusted for vehicle tier) prices shown subtly below recommended price. Employee can price anywhere in range without manager override.

**Confidence** — Three visual states:
- Green (solid circle): High confidence — all major conditions identified reliably
- Yellow (partial circle): Moderate confidence — some low-confidence findings, or limited photo quality
- Red (ring only): Low confidence — photos insufficient; employee should verify manually

**Estimated Labor** — Total in hours and minutes (e.g., "2 hrs 45 min"). Breakdown visible on tap.

**Difficulty Rating** — Badge: Routine (green) / Moderate (yellow) / Demanding (orange) / Time Trap (red).

**Reasoning** — Plain-language summary of how the AI arrived at the recommendation. Max 3 sentences.

**Suggested Upsells** — Separate section. Each: service name, one-sentence customer-facing rationale, add-on price, "Add to Estimate" button.

### 15.2 Findings Display Order

1. Time trap alerts (if any) — always first, always red/orange
2. Interior findings, most severe to least severe
3. Exterior paint findings, most severe to least severe
4. Glass findings
5. Wheel findings
6. Suggestions and upsells

---

## 16. Employee Review Screen

### 16.1 Screen Layout

**Section 1 — Vehicle Header Card**
Compact card: vehicle thumbnail, confirmed year/make/model/color (each tappable to edit), vehicle size category (tappable — triggers recalculation), customer name/phone.

Fields with AI confidence below 0.7 shown in yellow with soft underline.

**Section 2 — Time Trap Alert Banner**
Full-width red/orange banner (only if time trap detected). Lists each time trap. Shows total extra minutes. "Manager notified" badge if threshold exceeded.

**Section 3 — Findings List**
One card per finding. Each card:
- Location (human-readable)
- Condition name (human-readable)
- Severity badge (Light / Moderate / Heavy / Time Trap)
- AI description (2 sentences max)
- Labor contribution (+X min, muted)
- Confidence indicator (subtle green/yellow/red dot)
- Include/Exclude toggle (on by default)
- "Edit" button (opens bottom sheet)

At bottom of list: "+ Add Finding" button.

**Section 4 — Summary Bar (Sticky Footer)**
Always visible. Left: total labor. Center: recommended price (large, bold). Right: confidence dot. Two buttons: "Adjust Price" (secondary) / "Approve" (primary, blue).

### 16.2 Adjusting the Price

Bottom sheet: number input with current price, range displayed, real-time margin percentage. Color feedback: red if below minimum, yellow if above maximum. Optional reason field. "Apply" button.

### 16.3 Manager Approval Gate

If estimate requires review: "Approve" changes to "Request Manager Approval." Tapping marks estimate `pending_manager_review` and notifies manager. Manager reviews on their device and either approves or adjusts.

### 16.4 Confidence Indicators

- **≥ 0.85:** No indicator shown
- **0.60–0.84:** Subtle yellow dot; field pre-populated but highlighted
- **< 0.60:** Red dot; label shows "Verify — AI uncertain"; field pre-populated but employee expected to confirm

Confidence indicators are visual only. They never block any action.

---

## 17. Learning System

### 17.1 Core Principle

Every correction is a data point. Every accepted estimate is a signal that the AI's output was reasonable. The system captures both.

**Immutability rule:** AI predictions for every field are written once at analysis time and never changed by any subsequent operation. PATCH routes do not touch `ai_*` columns. This is non-negotiable.

### 17.2 What Is Captured Per Estimate

**Vehicle identification:**
- `ai_vehicle_year/make/model/color/size` vs confirmed values
- Vehicle confidence per field

**Per line item:**
- `ai_service_code` vs `service_code` — correct repair identified?
- `ai_severity` vs `severity` — severity rated correctly?
- `ai_labor_minutes` vs `labor_minutes` — time estimate accurate?
- `ai_confidence` — was confidence calibrated to actual accuracy?
- `was_identification_corrected` — employee changed the condition
- `was_severity_corrected` — employee adjusted severity
- `was_labor_corrected` — employee adjusted time
- `was_price_corrected` — employee changed price
- `was_added_by_employee` — AI missed this entirely
- `included` — false means employee excluded (possible false positive)

**Estimate level:**
- Employee review time (analysis complete → approval timestamp)
- Manager override presence and reason
- Customer decision (accepted / declined) and decline reason

**Photo level:**
- Quality score at upload
- "Use Anyway" choices — do low-quality photos correlate with low AI confidence?

### 17.3 AI Learning Dashboard

**Accuracy by Category (by prompt version):**
- Vehicle identification per field
- Finding type accuracy (scratch → scratch)
- Severity accuracy (light/moderate/heavy)
- Labor time accuracy (mean absolute error in minutes)

**Most Common Corrections:**
- AI code → confirmed code, sorted by frequency
- Severity adjustment direction (AI too high vs. too low)
- Labor adjustment direction and magnitude

**Confidence Calibration Table:**
Confidence bucket (0–20%, 20–40%, etc.) vs. actual accuracy for that bucket.

**False Positive Rate:** AI findings excluded by employee.

**Miss Rate:** Employee-added findings AI did not surface.

**Close Rate by Estimate Characteristics:** Accept rate by price range, vehicle type, condition severity.

### 17.4 Re-Run Dataset Tool

Admin selects saved estimates and re-runs them through the current prompt version. Results saved to `estimate_prompt_results` with no effect on confirmed ground truth. Enables before/after prompt comparison and model comparison.

### 17.5 Future Learning Path

- **Phase 1:** Manual prompt improvement from AI Learning dashboard observations
- **Phase 2:** Automated suggestion generation ("AI called 'heavy pet hair' in 12 cases where you changed it to 'moderate'")
- **Phase 3:** Fine-tuning on confirmed finding records (image + confirmed condition pairs) — 12+ months, sufficient dataset required

---

## 18. Analytics Dashboard

### 18.1 Overview Dashboard (Owner + Manager)

Time-range selector: Today / This Week / This Month / Last 30 Days / Custom

**KPI Cards:** Total Estimates, Total Approved (+ rate), Total Revenue, Average Estimate Value, Average Margin %, Total Declined (+ rate).

**Charts:**
- Estimates per day (bar, 30-day window)
- Revenue per day (line)
- Average estimate value trend (line, 90-day)
- Close rate trend (line, 90-day)
- Revenue by service category (horizontal bar)

### 18.2 Estimator Performance Dashboard (Manager)

By employee: estimates created, avg value vs. shop average, correction rate, avg review time.
By time trap detection: detected by AI vs. added by employee (miss rate).
By vehicle type: avg estimate value, close rate, most common service.

### 18.3 AI Accuracy Dashboard (Manager + Admin)

Described in Section 17.3. Additional panels: photo quality score distribution, analysis time trend, error/retry rate.

### 18.4 Pricing Analytics (Owner)

Price distribution histogram. Close rate by price range. Margin distribution. Manager override frequency and reasons. Declined estimate breakdown by reason.

---

## 19. Customer Experience

### 19.1 Estimate Share Link

After approval, system generates a customer-facing view at:

```
https://[domain]/estimate/[shareToken]
```

Share token: 64-character cryptographically random string. Expires after 7 days (configurable). Revocable by clearing the field.

**Customer view contains:** Pitt Stop branding, vehicle information (confirmed values), curated vehicle photos (overview shots only), services in plain language, itemized or total pricing (configurable), estimated completion time, "Approve Estimate" CTA, "Decline" text link, contact information.

**Customer view does NOT show:** AI confidence scores, internal service codes, margin, employee notes, time trap flags, raw AI response.

### 19.2 Customer Approval

Tapping "Approve": digital signature or confirm tap → `accepted_at` timestamp set → status: `accepted` → employee/manager notified → confirmation screen shown.

Tapping "Decline": optional one-question reason → `declined_at` set → reason stored → status: `declined` → employee notified.

### 19.3 SMS Delivery (Milestone 3 — Twilio)

```
Pitt Stop: Your vehicle estimate is ready. View and approve:
https://[domain]/estimate/[token]
Expires in 7 days. Reply STOP to opt out.
```

Opt-out stored on customer record.

### 19.4 Email Delivery (Milestone 3 — SendGrid)

HTML email: Pitt Stop branding header, vehicle photo embedded, summary, total, "View and Approve Estimate" button. Plain text version included.

### 19.5 PDF Estimate (Milestone 4)

Generated server-side (React-PDF or headless Chromium). Contains: Pitt Stop letterhead, estimate number, date and valid-through date, customer info, vehicle info, service line items with descriptions and pricing, total, terms and conditions, signature line, QR code linking to digital estimate.

---

## 20. Database Schema

### 20.1 `retail_customers`

```sql
retail_customers
  id                    uuid          PK DEFAULT gen_random_uuid()
  created_at            timestamptz   NOT NULL DEFAULT now()
  updated_at            timestamptz   NOT NULL DEFAULT now()
  name                  varchar(200)  NOT NULL
  phone                 varchar(30)                        -- E.164 format
  email                 varchar(200)
  notes                 text                               -- internal only
  crm_contact_id        varchar(200)                       -- reserved for CRM
  lifetime_revenue_cents integer                           -- cached aggregate
  visit_count           integer       NOT NULL DEFAULT 0
  sms_opt_out           boolean       NOT NULL DEFAULT false
  email_opt_out         boolean       NOT NULL DEFAULT false

INDEX: customers_phone_idx ON phone
INDEX: customers_email_idx ON email
UNIQUE INDEX: customers_phone_unique ON phone WHERE phone IS NOT NULL
```

### 20.2 `estimates`

```sql
estimates
  id                    uuid          PK DEFAULT gen_random_uuid()
  created_at            timestamptz   NOT NULL DEFAULT now()
  updated_at            timestamptz   NOT NULL DEFAULT now()

  -- Customer
  customer_id           uuid          REFERENCES retail_customers(id)
  customer_name         varchar(200)                       -- denormalized
  customer_phone        varchar(30)
  service_focus         varchar(50)                        -- employee intake selection

  -- AI-original vehicle (immutable)
  ai_vehicle_year       varchar(4)
  ai_vehicle_make       varchar(100)
  ai_vehicle_model      varchar(100)
  ai_vehicle_color      varchar(100)
  ai_vehicle_size       varchar(50)
  ai_value_tier         varchar(30)
  ai_has_third_row      boolean
  ai_has_sunroof        boolean
  ai_overall_condition  varchar(20)
  ai_interior_score     numeric(3,1)
  ai_difficulty_rating  varchar(20)
  ai_base_labor_minutes integer
  ai_condition_minutes  integer
  ai_total_labor_minutes integer
  ai_notes              text
  vehicle_confidence    jsonb

  -- Employee-confirmed vehicle (mutable)
  vehicle_year          varchar(4)
  vehicle_make          varchar(100)
  vehicle_model         varchar(100)
  vehicle_color         varchar(100)
  vehicle_size          varchar(50)
  license_plate         varchar(20)
  vin                   varchar(17)
  value_tier            varchar(30)
  has_third_row         boolean
  has_sunroof           boolean

  -- Pricing (mutable until approval)
  base_cost_cents             integer
  recommended_price_cents     integer
  price_range_low_cents       integer
  price_range_high_cents      integer
  approved_price_cents        integer
  tax_cents                   integer
  total_cents                 integer
  margin_percent              numeric(5,2)

  -- Pricing adjustments
  price_was_manually_adjusted boolean     NOT NULL DEFAULT false
  price_adjustment_reason     text
  price_adjusted_by           varchar(200)
  manager_override            boolean     NOT NULL DEFAULT false
  manager_override_reason     text
  manager_override_at         timestamptz

  -- Customer segment
  customer_type               varchar(30) NOT NULL DEFAULT 'retail'
  loyalty_discount_pct        numeric(4,1)

  -- AI metadata (immutable)
  prompt_version              varchar(50)
  model_name                  varchar(100)
  raw_ai_response             jsonb
  analysis_started_at         timestamptz
  analysis_completed_at       timestamptz

  -- Workflow
  status                      varchar(50) NOT NULL DEFAULT 'draft'
  was_corrected               boolean     NOT NULL DEFAULT false
  employee_id                 varchar(200)
  employee_confirmed_at       timestamptz
  estimate_number             varchar(20) NOT NULL           -- EST-YYYY-NNNNN

  -- Sharing
  share_token                 varchar(64) UNIQUE
  share_expires_at            timestamptz
  sent_at                     timestamptz
  sent_via                    varchar(20)
  accepted_at                 timestamptz
  declined_at                 timestamptz
  decline_reason              varchar(100)

  -- Integration (all nullable, reserved)
  quickbooks_estimate_id      varchar(200)
  quickbooks_invoice_id       varchar(200)
  autoleap_repair_order_id    varchar(200)
  scheduled_appointment_id    varchar(200)
  crm_deal_id                 varchar(200)

  -- Analytics timing
  employee_review_started_at  timestamptz
  employee_approved_at        timestamptz

INDEX: estimates_status_idx ON status
INDEX: estimates_customer_idx ON customer_id
INDEX: estimates_created_idx ON created_at DESC
INDEX: estimates_share_idx ON share_token WHERE share_token IS NOT NULL
INDEX: estimates_number_idx ON estimate_number
```

### 20.3 `estimate_photos`

```sql
estimate_photos
  id                    uuid         PK DEFAULT gen_random_uuid()
  estimate_id           uuid         NOT NULL REFERENCES estimates(id) ON DELETE CASCADE
  photo_url             text         NOT NULL
  role                  varchar(30)  NOT NULL
  capture_order         integer      NOT NULL
  quality_score         numeric(4,3)
  quality_flagged       boolean      NOT NULL DEFAULT false
  employee_override_quality boolean  NOT NULL DEFAULT false
  width_px              integer
  height_px             integer
  file_size_bytes       integer
  uploaded_at           timestamptz  NOT NULL DEFAULT now()

INDEX: photos_estimate_idx ON estimate_id
```

### 20.4 `estimate_line_items`

```sql
estimate_line_items
  id                              uuid         PK DEFAULT gen_random_uuid()
  estimate_id                     uuid         NOT NULL REFERENCES estimates(id) ON DELETE CASCADE
  display_order                   integer      NOT NULL DEFAULT 0

  -- AI-extracted (immutable)
  ai_photo_id                     uuid         REFERENCES estimate_photos(id)
  ai_category                     varchar(50)
  ai_location                     varchar(100)
  ai_damage_type                  varchar(50)
  ai_severity                     varchar(20)
  ai_description                  text
  ai_service_code                 varchar(100)
  ai_labor_minutes                integer
  ai_confidence                   numeric(4,3)
  ai_is_time_trap                 boolean      NOT NULL DEFAULT false
  ai_requires_manager_alert       boolean      NOT NULL DEFAULT false

  -- Employee-confirmed (mutable)
  description                     text
  service_code                    varchar(100)
  severity                        varchar(20)
  labor_minutes                   integer
  unit_price_cents                integer
  quantity                        numeric(6,2) NOT NULL DEFAULT 1
  line_total_cents                integer

  -- Correction tracking
  was_identification_corrected    boolean      NOT NULL DEFAULT false
  was_severity_corrected          boolean      NOT NULL DEFAULT false
  was_labor_corrected             boolean      NOT NULL DEFAULT false
  was_price_corrected             boolean      NOT NULL DEFAULT false
  was_added_by_employee           boolean      NOT NULL DEFAULT false
  included                        boolean      NOT NULL DEFAULT true
  notes                           text

  created_at                      timestamptz  NOT NULL DEFAULT now()

INDEX: line_items_estimate_idx ON estimate_id
INDEX: line_items_service_code_idx ON ai_service_code
INDEX: line_items_time_trap_idx ON ai_is_time_trap WHERE ai_is_time_trap = true
```

### 20.5 `pricing_catalog`

```sql
pricing_catalog
  id                   uuid          PK DEFAULT gen_random_uuid()
  code                 varchar(100)  NOT NULL UNIQUE
  category             varchar(50)   NOT NULL
  subcategory          varchar(50)
  name                 varchar(200)  NOT NULL
  customer_name        varchar(200)
  description          text
  base_unit_price_cents integer      NOT NULL DEFAULT 0
  default_labor_minutes integer      NOT NULL DEFAULT 0
  labor_rate_cents     integer       NOT NULL DEFAULT 0
  materials_pct        numeric(5,2)  NOT NULL DEFAULT 10
  unit                 varchar(30)   NOT NULL DEFAULT 'each'
  active               boolean       NOT NULL DEFAULT true
  sort_order           integer       NOT NULL DEFAULT 0
  is_time_trap         boolean       NOT NULL DEFAULT false
  minimum_price_cents  integer
  created_at           timestamptz   NOT NULL DEFAULT now()
  updated_at           timestamptz   NOT NULL DEFAULT now()

INDEX: catalog_category_idx ON category
INDEX: catalog_active_idx ON active WHERE active = true
```

### 20.6 `estimate_prompt_results`

```sql
estimate_prompt_results
  id              uuid         PK DEFAULT gen_random_uuid()
  estimate_id     uuid         NOT NULL
  prompt_version  varchar(50)  NOT NULL
  model_name      varchar(100) NOT NULL
  raw_response    jsonb
  parsed_vehicle  jsonb
  parsed_findings jsonb
  labor_summary   jsonb
  processed_at    timestamptz  NOT NULL DEFAULT now()

INDEX: estimate_rerun_entry_idx ON estimate_id
INDEX: estimate_rerun_prompt_idx ON prompt_version
```

### 20.7 `estimator_config`

```sql
estimator_config
  id               uuid         PK DEFAULT gen_random_uuid()
  key              varchar(100) NOT NULL UNIQUE
  value            text         NOT NULL
  description      text
  updated_at       timestamptz  NOT NULL DEFAULT now()

-- Seed rows:
-- target_hourly_rate_cents          = '9500'      ($95/hr)
-- minimum_margin_pct                = '40'
-- max_price_multiplier              = '1.4'
-- luxury_premium_pct                = '15'
-- share_token_expiry_days           = '7'
-- manager_approval_threshold_cents  = '50000'
-- manager_approval_complexity       = 'time_trap'
-- markup_multiplier                 = '2.2'
-- retail_repeat_discount_pct        = '7'
-- tax_rate_pct                      = '0'
```

---

## 21. API Architecture

### 21.1 Estimate Lifecycle

#### `POST /api/estimator/analyze`

Accept photos, run AI analysis, create estimate and all related records.

**Request:** `multipart/form-data`

```
image_0..N    File           -- photos in capture order (minimum 2)
role_0..N     string         -- 'driver_side' | 'passenger_side' | etc.
customer_name  string (required)
customer_phone string (required)
vehicle_size   string (optional)
service_focus  string (optional)
```

**Processing:**
1. Validate: ≥ 2 photos, all images, total < 40MB
2. Resize each to max 2048px server-side
3. Upload all to Vercel Blob in parallel
4. Find or create customer record by phone
5. Create `estimates` record with status `ai_pending`
6. Create `estimate_photos` records
7. Build AI prompt (inject catalog codes, service focus)
8. Send all photos in single GPT-4o vision request
9. Parse response (retry once on parse failure; set `needs_review` after two failures)
10. Create `estimate_line_items` from parsed findings (ai_* fields only)
11. Run pricing engine; write pricing fields to estimate
12. Set status: `needs_review` if time trap + complexity threshold; else `draft`
13. Return `{ estimateId, status, timeTrapDetected }`

**Errors:**
- `400`: Missing photos / invalid file type / missing customer fields
- `413`: Upload size exceeded
- `422`: AI parse failed after retry
- `429`: AI provider rate limited
- `500`: AI API error / Blob failure

---

#### `GET /api/estimator/estimates`

List estimates with pagination and filters.

**Query params:** `status`, `date_from`, `date_to`, `customer_id`, `search`, `limit` (default 50, max 200), `offset`

---

#### `GET /api/estimator/estimates/[id]`

Full estimate detail including photos and line items.

---

#### `PATCH /api/estimator/estimates/[id]`

Update vehicle info, customer info, status, pricing. **Never touches `ai_*` columns.**

---

#### `POST /api/estimator/estimates/[id]/line-items`

Add a finding the AI missed. Sets `was_added_by_employee = true`. All `ai_*` fields null.

---

#### `PATCH /api/estimator/estimates/[id]/line-items/[lid]`

Correct an AI finding. Auto-sets correction flags:
- `was_identification_corrected` if `serviceCode` changed from `ai_service_code`
- `was_severity_corrected` if `severity` changed from `ai_severity`
- `was_labor_corrected` if `laborMinutes` changed from `ai_labor_minutes`
- `was_price_corrected` if `unitPriceCents` changed from catalog default

---

#### `DELETE /api/estimator/estimates/[id]/line-items/[lid]`

Remove employee-added line items only. Returns 400 if `was_added_by_employee = false` (use PATCH with `included: false` instead — preserves false-positive data).

---

#### `POST /api/estimator/estimates/[id]/approve`

Finalize estimate. Validates margin. Computes totals. Sets `approved` status. Generates estimate number. Updates customer visit count and lifetime revenue.

---

#### `POST /api/estimator/estimates/[id]/share`

Generate share token and expiry. Returns `{ shareUrl }`.

---

#### `GET /api/estimator/share/[token]`

Public endpoint. Returns customer-safe estimate data. Validates token exists and is not expired.

---

#### `POST /api/estimator/share/[token]/respond`

Record customer accept or decline. Rate-limited to 5 requests per IP per hour.

---

### 21.2 Pricing Catalog

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/estimator/catalog` | List active items; used for review screen dropdowns |
| `POST` | `/api/estimator/catalog` | Admin: create service code |
| `PATCH` | `/api/estimator/catalog/[id]` | Admin: update name, price, labor time, active status |
| `DELETE` | `/api/estimator/catalog/[id]` | Admin: soft delete (sets `active = false`) |

### 21.3 Learning

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/estimator/reanalyze` | Re-run photos through current prompt; store in `estimate_prompt_results` |

### 21.4 Customer

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/estimator/customers` | Create or find customer by phone |
| `GET` | `/api/estimator/customers/[id]` | Customer detail + estimate history |

### 21.5 Error Response Shape

```json
{
  "error": "short_machine_readable_code",
  "message": "Human-readable explanation for logging",
  "detail": {}
}
```

HTTP status codes used semantically: 400 (client error, don't retry), 404 (not found), 409 (conflict), 413 (too large), 422 (unprocessable), 429 (rate limited), 500 (server error, retry with backoff), 503 (AI provider unavailable).

---

## 22. UI Wireframes

These are intent wireframes — layout and content structure, not visual design. All screens use the Pitt Stop dark theme (`bg-gray-950`) consistent with Module 1.

### 22.1 Intake Screen (`/estimator`)

```
┌────────────────────────────────┐
│ ← Pitt Stop OS                 │
│                                │
│  Retail AI Estimator           │
│  Create a new estimate         │
│                                │
│ ┌────────────────────────────┐ │
│ │ Customer Name*             │ │
│ │ ________________________  │ │
│ └────────────────────────────┘ │
│                                │
│ ┌────────────────────────────┐ │
│ │ Phone Number*              │ │
│ │ ________________________  │ │
│ └────────────────────────────┘ │
│                                │
│  What are we looking at?       │
│  ○ Full Detail                 │
│  ● Exterior Only               │
│  ○ Interior Only               │
│  ○ Specific Service            │
│                                │
│ ┌────────────────────────────┐ │
│ │   Take Vehicle Photos  →   │ │
│ └────────────────────────────┘ │
└────────────────────────────────┘
```

### 22.2 Photo Capture Screen (`/estimator/capture/[id]`)

```
┌────────────────────────────────┐
│  Photo 3 of 8                  │
│  ████████░░░░░░░░░░  38%       │
│                                │
│ ┌────────────────────────────┐ │
│ │                            │ │
│ │   [Camera Viewfinder]      │ │
│ │                            │ │
│ │   Rear — Driver Side       │ │
│ │   Step back 8–10 feet      │ │
│ │                            │ │
│ └────────────────────────────┘ │
│                                │
│ Thumbnails: [✓][✓][   ][   ]  │
│                                │
│    ○  [  Take Photo  ]  ○      │
│       [  Skip This   ]         │
│                                │
│ ⚠ Poor lighting detected       │
│   Tap to proceed anyway →      │
└────────────────────────────────┘
```

### 22.3 Analysis Progress Screen

```
┌────────────────────────────────┐
│                                │
│         Analyzing...           │
│                                │
│    ●  Photos uploaded    ✓     │
│    ●  AI analyzing       ⟳     │
│    ○  Generating estimate      │
│                                │
│  [Vehicle thumbnail grid 2×4]  │
│                                │
│  Estimated wait: ~12 seconds   │
│                                │
│  "You can add or remove items  │
│   on the next screen."         │
│                                │
└────────────────────────────────┘
```

### 22.4 Employee Review Screen (`/estimator/review/[id]`)

```
┌────────────────────────────────┐
│ Review Estimate                │
│                                │
│ ┌────────────────────────────┐ │
│ │ [thumb] 2019 Honda Accord  │ │
│ │         Silver • Mid-Size  │ │
│ │         Sarah M.  555-1234 │ │
│ └────────────────────────────┘ │
│                                │
│ ⚠ TIME TRAP DETECTED           │
│  Heavy pet hair (+85 min)      │
│  Manager required              │
│                                │
│ ─── Findings ──────────────── │
│                                │
│ [Finding Card]                 │
│  Interior — Front Seats        │
│  Heavy Pet Hair  🔴  SEVERE    │
│  Extraction + shampoo: +85min  │
│  AI confidence: ●● [toggle]   │
│                                │
│ [Finding Card]                 │
│  Exterior — Driver Door        │
│  Light Scratch  🟡  LIGHT      │
│  Buff and polish: +15min       │
│  AI confidence: ●●● [toggle]  │
│                                │
│ [+ Add Finding]                │
│                                │
│ ┌────────────────────────────┐ │
│ │  3h 10m    $285    ●●○    │ │
│ │  [Adjust]  [Request Mgr]   │ │
│ └────────────────────────────┘ │
└────────────────────────────────┘
```

### 22.5 Customer Estimate View (`/estimate/[token]`)

```
┌────────────────────────────────┐
│  [Pitt Stop Logo]              │
│                                │
│  Hi Sarah,                     │
│  Your estimate is ready.       │
│                                │
│  2019 Honda Accord • Silver    │
│  [Vehicle photo]               │
│                                │
│  ─── Services ──────────────  │
│  Interior Deep Detail    $180  │
│  Pet Hair Extraction      $65  │
│  Exterior Buff & Polish   $40  │
│  ─────────────────────────── │
│  Total                   $285  │
│                                │
│  ┌──────────────────────────┐  │
│  │    Approve Estimate  →   │  │
│  └──────────────────────────┘  │
│                                │
│  No thanks, decline →          │
│                                │
│  Questions? Call us:           │
│  (555) 123-4567                │
│  Valid through July 21, 2026   │
└────────────────────────────────┘
```

---

## 23. Integrations

### 23.1 Integration Principles

All integrations are optional and additive. The estimator is fully functional without any integration. Integration failures must not block estimate creation or approval. All integration IDs stored on the estimate record for cross-referencing.

### 23.2 QuickBooks Online (Milestone 3)

**Purpose:** Push approved estimates to QuickBooks as a formal estimate; convert to invoice when service is complete.

**Implementation:**
- QuickBooks OAuth 2.0 token stored in environment (not per-estimate)
- `POST /api/estimator/estimates/[id]/push-qbo` — push to QuickBooks, store `quickbooks_estimate_id`
- On service completion: `POST /api/estimator/estimates/[id]/invoice-qbo` — convert to invoice
- Supports PILOT_MODE: in test mode, log payload instead of calling QBO API

**Field Mapping:**
- Estimate `estimate_number` → QuickBooks Ref No
- Line items → QuickBooks line items with descriptions from `customer_name` in `pricing_catalog`
- `approved_price_cents` → QuickBooks amount (tax excluded, per QB convention)
- Customer → QuickBooks Customer by name+email; create if not found

### 23.3 AutoLeap (Milestone 4)

**Purpose:** Create a repair order in AutoLeap from an approved estimate.

**Implementation:** AutoLeap REST API (API key, not OAuth). Endpoint: `POST /api/estimator/estimates/[id]/push-autoleap`. Store `autoleap_repair_order_id` on estimate.

**Current status:** API key, base URL, and endpoint paths TBD — requires AutoLeap account setup.

### 23.4 Twilio SMS (Milestone 3)

**Purpose:** Deliver estimate share link via SMS.

**Implementation:**
- Twilio SDK via serverless function `POST /api/estimator/estimates/[id]/send-sms`
- Message template stored in `estimator_config`, not hardcoded
- On success: set `sent_at`, `sent_via = 'sms'`
- Opt-out honored: check `sms_opt_out` before sending; return 200 with `{ skipped: true }` if opted out
- PILOT_MODE: log message to console; do not call Twilio

### 23.5 SendGrid Email (Milestone 4)

**Purpose:** Send branded HTML estimate email.

**Implementation:**
- SendGrid Dynamic Templates
- Template ID stored in environment variable
- Attach generated PDF if available (see Section 19.5)
- On success: set `sent_at`, `sent_via = 'email'` (or `'sms+email'`)

### 23.6 Future: CRM Integration

One estimate per CRM deal (create or match). Estimate status synced bidirectionally (CRM deal won/lost updates `accepted_at` / `declined_at`). CRM identity stored as `crm_deal_id` on estimate record. Provider TBD.

### 23.7 Future: Calendar / Scheduling

Book appointment slot on estimate approval. Duration from `approved_labor_minutes` + 20-minute buffer. Send calendar invite to customer at confirmed email. Provider TBD.

---

## 24. Security

### 24.1 Authentication and Authorization

All `/admin/*` routes and all `/api/estimator/*` write endpoints require authenticated session. Session management handled by Pitt Stop platform auth (same as Module 1).

Public endpoints:
- `GET /api/estimator/share/[token]` — no auth, token is the credential
- `POST /api/estimator/share/[token]/respond` — no auth, rate-limited

No customer accounts. No password storage. No PII beyond name + phone + email.

### 24.2 Share Token Security

- 64 bytes, `crypto.getRandomValues()` — cryptographically random
- Stored as plain text (not sensitive enough to hash; lookup is direct)
- Expiry enforced server-side at every read
- Revoked by clearing token field; revocation is immediate
- Expired tokens return `404`, not `410` — no information about whether token ever existed

### 24.3 Input Validation

All API input validated at system boundary:
- File type: MIME type check + magic bytes check (do not trust `Content-Type` header alone)
- File size: reject any single file > 10MB; reject total batch > 40MB
- Phone: normalize to E.164, reject non-numeric characters beyond `+`
- Price fields: reject negative values; reject values above $100,000 (configurable max)
- SQL: all queries via Drizzle ORM parameterized — no string interpolation in SQL

### 24.4 AI Response Validation

AI output is untrusted external input. Validation pipeline:
1. Parse as JSON (catch malformed)
2. Validate against schema (Zod or equivalent)
3. Reject or sanitize any field that looks like a prompt injection attempt (unexpected `<<<` or `>>>` patterns, extreme length)
4. Clamp numeric fields to sane ranges: labor minutes 0–480, confidence 0–1, price 0–999999
5. Reject any `service_code` not present in current `pricing_catalog` (prevents hallucinated codes)

### 24.5 Photo Privacy

Vehicle photos contain partial or full license plates, VINs, and customer-identifiable information. Controls:
- Photos stored in Vercel Blob under a path that includes a random prefix (not guessable)
- Customer-facing estimate view shows only photos with `role IN ('overview', 'front', 'rear')` — not detail close-ups with VINs
- No photo URLs exposed in public share API response by default (configurable)
- Photos not indexed by search engines (not linked from public pages, no sitemap reference)

### 24.6 Rate Limiting

| Endpoint | Limit | Window |
|---|---|---|
| `POST /api/estimator/analyze` | 20/hr per IP | Rolling hour |
| `POST /api/estimator/share/*/respond` | 5/hr per IP | Rolling hour |
| `POST /api/estimator/*/send-sms` | 10/hr per employee | Rolling hour |

Rate limiting implemented via Vercel Edge Config or Upstash Redis (Vercel native KV). Returns `429` with `Retry-After` header.

### 24.7 Logging

All API calls logged with: timestamp, method, path, status, duration, employee ID (if authenticated), estimate ID (if applicable). Logs must never contain: full AI responses (too large), customer phone numbers (mask to last 4), API keys, share tokens.

---

## 25. Acceptance Tests

These tests define "done" for Milestone 2. Every test must pass for the milestone to be considered complete.

### 25.1 Photo Capture

- [ ] Employee can capture minimum 2 photos and proceed to analysis
- [ ] Camera prompt guides through 8-photo sequence with progress indicator
- [ ] Quality warning shown for dark or blurry photos
- [ ] Employee can override quality warning and proceed
- [ ] Employee can retake any photo before submitting
- [ ] Photos uploaded to Vercel Blob with correct folder structure
- [ ] Total upload size > 40MB returns 413 with user-facing error

### 25.2 AI Analysis

- [ ] All photos sent in single API request
- [ ] Analysis completes in under 25 seconds for 8 photos
- [ ] Vehicle year/make/model/color extracted from photos
- [ ] At least one interior finding generated for vehicle with visible interior
- [ ] At least one exterior finding generated for vehicle with visible damage
- [ ] Time trap flagged when heavy pet hair visible in photos
- [ ] Analysis failure (AI API error) shows user-facing error; estimate not created in broken state
- [ ] Prompt version stored on every estimate record

### 25.3 Review Screen

- [ ] All AI findings rendered in review screen with correct labels and severity
- [ ] AI fields with confidence < 0.7 shown in yellow
- [ ] Employee can edit any field on any finding
- [ ] Correction flags set correctly on save (was_severity_corrected, etc.)
- [ ] Employee can add a finding the AI did not surface
- [ ] Employee can exclude (but not delete) AI findings; excluded findings preserved for learning
- [ ] Sticky footer shows correct total labor, recommended price, confidence dot
- [ ] Price adjustment bottom sheet enforces minimum and maximum with visual feedback

### 25.4 Approval Gate

- [ ] Time trap estimate shows manager approval requirement
- [ ] "Request Manager Approval" sets status to `pending_manager_review`
- [ ] Manager can approve or adjust from their device
- [ ] Non-time-trap estimates can be approved by employee without manager
- [ ] Approved estimate sets `approved_at` timestamp

### 25.5 Share

- [ ] Share link generated with 64-char random token
- [ ] Customer view renders correctly with correct services and total
- [ ] Customer "Approve" sets `accepted_at`; customer "Decline" sets `declined_at` and stores reason
- [ ] Expired token (past `share_expires_at`) returns 404
- [ ] Revoked token (null `share_token`) returns 404

### 25.6 Learning Data Integrity

- [ ] After employee edits, `ai_*` columns unchanged (verified by SQL query)
- [ ] `was_severity_corrected` true when employee changed severity from AI value
- [ ] `was_added_by_employee` true for employee-added findings
- [ ] Employee-excluded finding: `included = false`, record preserved, `ai_*` unchanged

### 25.7 Admin

- [ ] Admin can view estimate list with status filter
- [ ] Admin can view full estimate detail including correction history
- [ ] Admin can view pricing catalog and add/edit/deactivate service codes
- [ ] AI Learning dashboard shows accuracy by prompt version (even if only one version exists)

### 25.8 Performance

- [ ] Analysis endpoint responds in < 30 seconds at p95
- [ ] Review screen renders in < 2 seconds for estimates with 20+ line items
- [ ] Admin estimate list loads 50 estimates in < 1 second
- [ ] Photo uploads complete in < 15 seconds for 8 photos on typical mobile connection

---

## 26. Future Roadmap

Roadmap items are ordered by expected implementation sequence within each milestone. Items may move between milestones based on operational learnings.

### Milestone 3 (Post-Launch, Month 1–3)

- **SMS delivery** — Twilio integration for share link delivery
- **QuickBooks integration** — Push approved estimates, convert to invoice on completion
- **Customer history** — See prior estimates by phone number at intake
- **Repeat customer detection** — Auto-flag returning customers, apply loyalty discount
- **Manager dashboard** — Dedicated view for pending approval queue
- **Estimate templates** — Pre-filled service packages (e.g., "Pre-Sale Package", "Dealer Batch Detail") employee can select and modify

### Milestone 4 (Month 3–6)

- **PDF estimate generation** — Printable estimate with letterhead and signature line
- **Email delivery** — SendGrid with PDF attachment
- **AutoLeap repair order** — Push to shop management system
- **Calendar booking** — Schedule appointment from estimate approval
- **Upsell performance tracking** — Which upsells convert; which AI suggestions drive revenue

### Milestone 5 (Month 6–12)

- **Customer portal (beta)** — Account creation, estimate history, rebooking
- **Stripe payments** — Deposit collection at estimate approval
- **AI prompt auto-suggestions** — Dashboard highlights patterns and generates prompt improvement candidates for review
- **Photo comparison view** — Before/after photo pairs on completed estimates

### Milestone 6 (Month 12–24)

- **Fine-tuning dataset** — Export confirmed findings as structured dataset; evaluate fine-tuning feasibility
- **Custom AI model evaluation** — Compare fine-tuned model vs. GPT-4o on held-out validation set
- **CRM integration** — Bidirectional sync of estimate and deal status

---

## 27. Estimator Intelligence — Long-Term Vision

### 27.1 The Core Premise

Every estimate is a data point. Every correction is a labeled sample. Every customer decision (accept/decline) is a business signal. After 1,000 estimates, Pitt Stop has something most detailing businesses never accumulate: a structured dataset of vehicle condition, labor predictions, pricing, and outcomes.

This section describes how to use it.

### 27.2 Phase 1: Human-Guided Prompt Refinement (Now–Month 6)

Primary loop: AI makes prediction → employee corrects → AI Learning dashboard surfaces patterns → human writes better prompt → next prompt version is more accurate.

This is the only loop available at launch. It requires no infrastructure beyond what's already built. It works well up to ~90% accuracy on common conditions. After that, the most impactful improvements require training data.

### 27.3 Phase 2: AI-Suggested Prompt Improvements (Month 6–12)

Trigger: ≥ 50 correction events on a specific condition category.

The system generates: "When employees see 'light scratch on door' (AI code: `paint_scratch_light`), they change severity to 'heavy' 62% of the time. Suggested prompt update: define 'light' as < 1-inch length and no paint transfer. Would you like to add this?"

Employee or owner accepts/rejects each suggestion. Accepted suggestions queue for prompt update. A/B behavior on next 50 estimates (not random — by prompt version).

### 27.4 Phase 3: Fine-Tuning Evaluation (Month 12–24)

Requires: ≥ 2,000 confirmed estimates with full ground truth.

Export: `(photo_set, confirmed_findings_json)` pairs. Fine-tune GPT-4o or equivalent on labeled pairs. Evaluate on held-out 20% validation set. Compare to current GPT-4o with engineered prompt: accuracy per category, labor MAE, false positive rate, miss rate.

Deploy fine-tuned model only if it outperforms on at least 3 of 4 metrics on the validation set. Keep prompt-based model as fallback.

### 27.5 Phase 4: Predictive Pricing Intelligence (Month 18–36)

Inputs: vehicle type, condition profile, season, day of week, current shop capacity utilization.
Output: recommended price adjusted for close probability. "Lower this estimate from $285 to $260 — estimates above $260 have a 38% close rate for this vehicle type. At $260, close rate is 71%."

Data requirement: ≥ 500 estimates with customer decision recorded per vehicle/condition segment.

This is a pricing model, not a vision model. Classic regression or light gradient boosting — no LLM required.

### 27.6 The Dataset's Long-Term Value

If Pitt Stop grows to 10,000 confirmed estimates across multiple locations, the labeled dataset becomes: (1) a proprietary asset that competitors cannot replicate by purchasing models; (2) a training foundation for a domain-specific detailing AI that outperforms general vision models; (3) a benchmarking tool to evaluate future AI models as they are released.

The dataset is worth protecting accordingly: it should never be used as training data by third-party model providers. API agreements with providers that claim training rights on API inputs should be reviewed against this requirement.

---

## 28. Implementation Roadmap

### Milestone 1: Foundation (Weeks 1–2)

**Goal:** Estimate created, analyzed, and reviewable. No customer delivery. No integrations.

- [ ] Database migrations: `retail_customers`, `estimates`, `estimate_photos`, `estimate_line_items`, `pricing_catalog`, `estimator_config` (seed data), `estimate_prompt_results`
- [ ] Photo capture flow: intake screen, 8-photo capture UI, Vercel Blob upload
- [ ] GPT-4o vision integration: single multi-image request, structured output, parse and validate
- [ ] Labor estimation engine: service → base minutes → size modifier → condition modifiers → total minutes → cost → recommended price
- [ ] Review screen: findings list, edit/exclude/add, price adjustment, sticky footer
- [ ] Approval flow: approve (employee) or escalate (manager) based on configurable threshold
- [ ] Basic admin list: `/admin/estimator` with status filter and detail view

**Definition of done:** Employee can capture 8 photos, receive AI analysis, correct any findings, and approve an estimate — producing a complete `estimates` record with full ground truth.

### Milestone 2: Customer Delivery (Weeks 3–4)

**Goal:** Customer can receive and respond to their estimate.

- [ ] Share token generation (`POST .../share`)
- [ ] Public estimate view at `/estimate/[token]` — no auth required
- [ ] Customer accept flow: `POST .../respond` with action=accept
- [ ] Customer decline flow: `POST .../respond` with action=decline + reason
- [ ] Share link copy-to-clipboard + manual SMS (employee sends from native phone app)
- [ ] Status updates on employee-facing estimate when customer responds

**Definition of done:** Employee shares estimate, customer opens link, approves, and employee sees `accepted` status on their screen.

### Milestone 3: Operations (Month 2)

- [ ] Twilio SMS delivery
- [ ] QuickBooks estimate push
- [ ] Customer history lookup at intake
- [ ] Repeat customer detection + loyalty discount
- [ ] Manager approval queue (mobile-optimized view)
- [ ] Analytics dashboard — overview metrics
- [ ] AI Learning dashboard — accuracy by prompt version

### Milestone 4: Full Integration (Month 3–4)

- [ ] PDF estimate generation
- [ ] SendGrid email delivery
- [ ] AutoLeap repair order push
- [ ] Full analytics dashboards (pricing, estimator performance)
- [ ] Upsell conversion tracking

---

## 29. Design Decisions

### Why not let the AI output a price?

The AI has no awareness of Pitt Stop's cost structure, target margin, hourly labor rate, or local market pricing. Pricing is a business decision, not a vision recognition task. The AI outputs labor time estimates and condition findings. The server-side pricing engine applies Pitt Stop's business logic to produce a price. This separation means pricing can be tuned without changing the AI prompt, and the AI's role is narrowly defined around what it can actually be held accountable for.

### Why is the AI immutability rule non-negotiable?

The AI Learning system only works if the ground truth (what the employee confirmed) and the AI prediction are permanently stored separately. If PATCH routes could overwrite `ai_*` columns, every correction would destroy the before/after signal that drives prompt improvement. This is not a "nice to have" — it is the foundation of the entire learning pipeline.

### Why is every photo sent in a single request instead of per-photo?

Detailing estimation is inherently about the whole vehicle. A scratch on the driver door is more or less significant depending on the overall condition of the vehicle. A vehicle with one scratch costs less than a vehicle with one scratch, pet hair, smoke smell, and a cracked dashboard. Sending all photos in a single request gives the AI full context for holistic reasoning. It also avoids prompt injection by staggered requests and keeps the AI's spatial reasoning intact (it can correlate "heavy pet hair in rear seats" with "heavily soiled rear carpet" as a single time trap).

### Why not implement per-customer accounts for the customer estimate view?

The share link is sufficient for the use case. Customers receive one estimate per visit. They don't need a login, a password reset flow, or a history view to approve an estimate. Adding account creation adds friction that reduces conversion. A 64-character cryptographic share token is more secure than most password-based logins. Customer accounts are a future roadmap item only if customers explicitly request it.

### Why use a fixed 8-photo sequence instead of letting employees take any photos?

Employees working quickly with an anxious customer do not have bandwidth to make photo composition decisions. A fixed sequence ensures: (1) the AI always receives comparable inputs for consistent analysis; (2) training data is structurally identical across estimates, enabling learning; (3) employees don't accidentally skip the rear bumper or headliner; (4) the review screen can render photos in a predictable order. Employees can add supplemental photos for specific damage, but the base sequence is always the same.

### Why recommend a price rather than a range?

Ranges introduce negotiation. "Your estimate is $220–$285" signals to the customer that $220 is available if they push. A single recommended price, confidently presented, sets a professional anchor. The pricing range is visible to employees for adjustment context, but the customer sees one number. This mirrors how premium service businesses price — not "somewhere between X and Y" but "the price is X."

### Why is the customer decline reason optional?

Asking for a reason at the moment of decline is a judgment call: useful data vs. friction that might prevent the customer from completing any action. The decline reason is optional (one tap to skip) because a clean "declined" signal is more valuable than a half-completed decline flow where the customer closes the browser. The reason, when provided, is valuable — but not at the cost of the conversion signal.

---

## 30. Future Ideas — Parking Lot

These items are not planned for any current milestone. They are captured here to prevent repeated re-discussion and to preserve the reasoning for or against them.

**Fleet / Lot Inspection Mode** — Employee walks a dealer lot, capturing photos of multiple vehicles in sequence. Estimates generated in bulk. Reviewed and approved in batch. Requires batch estimate UI and dealer-specific pricing schedules. Not planned until Module 1 dealer batch flow is mature.

**Video Capture Instead of Photos** — Employee takes a 30-second walk-around video. AI analyzes key frames. Pros: faster employee workflow, no "did you get the right angle" anxiety. Cons: much larger files, more expensive per analysis, frame extraction adds latency. Re-evaluate when video analysis cost/latency improves.

**Voice Notes on Intake** — Employee records a 15-second note ("customer mentioned it smells like cigarettes in the back"). Transcribed and injected into AI system prompt as context. Small but high-signal input. Deferred because it requires Whisper API integration and mobile audio capture testing.

**Tips and Gratuity** — Add optional gratuity at customer approval step. "Add a tip for your technician: [15%] [20%] [Custom]." Stripe required. Gratuity tracked per employee. High-morale feature; deferred to Milestone 4+ (Stripe integration prerequisite).

**Comparison Estimates** — Side-by-side view of two estimates for the same vehicle. "This estimate is $40 more than the last estimate for a similar vehicle — difference driven by interior condition scoring." Useful for employee training and manager review.

**Automated Follow-Up** — If customer doesn't respond to estimate within 48 hours, send one follow-up SMS. Single follow-up only. Opt-out always honored. Requires Twilio (Milestone 3 prerequisite).

**Estimate Expiry Renewal** — Allow employee to reactivate an expired estimate with a new token and updated pricing. Preserves original as archived. Avoids re-photographing a vehicle that came back for a second look.

**Competitive Intelligence** — Employee records what competitor quoted (if customer discloses). Stored as `competitor_price_cents` on declined estimates. Aggregate view: how often Pitt Stop is priced above/below market, by service type. One field addition, no UI complexity. Worth doing when analytics dashboard is built.

**AI Estimate Narration** — Customer-facing estimate accompanied by a 30-second AI-generated voice summary: "Your vehicle has some light scuffs on the passenger door and we'd recommend a deep interior clean. Here's what we found and why we priced it this way." High novelty value; significant implementation complexity. Long-term differentiator if AI voice quality continues to improve.

**Multi-Location Support** — Each location has its own `estimator_config` (hourly rate, markup, minimums). Pricing differs by location. Employee logs in to a location; all estimates tagged to location. Requires location entity in DB and per-location config resolution. Deferred until second Pitt Stop location is a real business plan item.

**Technician Assignment on Approval** — On estimate approval, display available technicians and current queue. Assign estimate to technician with one tap. Estimated time slot calculated from labor minutes. Requires production board data (Module 4 prerequisite).

**Instant Rebooking** — On completed estimate (service done), one-tap "Book Again?" sends new estimate link for next visit. Pre-fills customer info and previous service package. Drives repeat business without employee outreach. Deferred until post-launch, when estimate history and customer retention become a focus.
