import type { VehicleLayout } from './vehicle-layout'

export type PhotoOrientation = 'landscape' | 'portrait' | 'close-up'

export type PhotoStep = {
  role:        string
  label:       string
  hint:        string
  orientation: PhotoOrientation
  optional:    boolean
  bonus:       boolean   // opt-in "add if relevant" step — never required
}

const MAX_PHOTOS = 10

// ── Step definitions ───────────────────────────────────────────────────────

const STEPS: Record<string, PhotoStep> = {
  interior_front_driver: {
    role:        'interior_front_driver',
    label:       'Front Driver Cabin',
    hint:        'Open the driver door — show the seat, floor, and pedals clearly in one photo',
    orientation: 'portrait',
    optional:    false,
    bonus:       false,
  },
  interior_rear_driver: {
    role:        'interior_rear_driver',
    label:       'Rear Driver Side',
    hint:        'Photograph the rear seat and floor on the driver side',
    orientation: 'portrait',
    optional:    false,
    bonus:       false,
  },
  interior_third_row: {
    role:        'interior_third_row',
    label:       'Third Row',
    hint:        'Photograph the third-row seats and floor',
    orientation: 'portrait',
    optional:    false,
    bonus:       false,
  },
  interior_cargo: {
    role:        'interior_cargo',
    label:       'Cargo Area',
    hint:        'Photograph the cargo area behind the last row of seats',
    orientation: 'portrait',
    optional:    false,
    bonus:       false,
  },
  interior_trunk: {
    role:        'interior_trunk',
    label:       'Trunk',
    hint:        'Open the trunk and photograph the full interior',
    orientation: 'portrait',
    optional:    true,
    bonus:       false,
  },
  interior_rear_passenger: {
    role:        'interior_rear_passenger',
    label:       'Passenger Rear',
    hint:        'Photograph the rear seat and floor on the passenger side',
    orientation: 'portrait',
    optional:    false,
    bonus:       false,
  },
  interior_front_passenger: {
    role:        'interior_front_passenger',
    label:       'Front Passenger Cabin',
    hint:        'Open the passenger door — show the seat, floor, and foot well in one photo',
    orientation: 'portrait',
    optional:    false,
    bonus:       false,
  },
  interior_console: {
    role:        'interior_console',
    label:       'Center Console & Cup Holders',
    hint:        'Get close enough to clearly show cup holders, gear shift, controls, and sticky high-touch areas',
    orientation: 'close-up',
    optional:    false,
    bonus:       false,
  },
  interior_worst_area: {
    role:        'interior_worst_area',
    label:       'Worst Interior Problem',
    hint:        'Add only if you see heavy staining, pet hair, mold, burns, or major spills — skip if the interior is in normal condition',
    orientation: 'close-up',
    optional:    true,
    bonus:       true,
  },
  exterior_front: {
    role:        'exterior_front',
    label:       'Front Exterior',
    hint:        'Capture the front bumper, grille, and hood',
    orientation: 'portrait',
    optional:    false,
    bonus:       false,
  },
  exterior_driver_side: {
    role:        'exterior_driver_side',
    label:       'Driver Side',
    hint:        'Turn phone sideways and fit the full driver side of the vehicle in the frame',
    orientation: 'landscape',
    optional:    false,
    bonus:       false,
  },
  exterior_rear: {
    role:        'exterior_rear',
    label:       'Rear Exterior',
    hint:        'Capture the rear bumper, taillights, and tailgate or trunk lid',
    orientation: 'portrait',
    optional:    false,
    bonus:       false,
  },
  exterior_passenger_side: {
    role:        'exterior_passenger_side',
    label:       'Passenger Side',
    hint:        'Turn phone sideways and fit the full passenger side of the vehicle in the frame',
    orientation: 'landscape',
    optional:    false,
    bonus:       false,
  },
  exterior_truck_bed: {
    role:        'exterior_truck_bed',
    label:       'Truck Bed',
    hint:        'Open the tailgate and photograph the full interior of the truck bed',
    orientation: 'portrait',
    optional:    false,
    bonus:       false,
  },
  exterior_worst_area: {
    role:        'exterior_worst_area',
    label:       'Worst Exterior Problem',
    hint:        'Add only if you see deep scratches, oxidation, tar, tree sap, or major damage — skip if the exterior is in normal condition',
    orientation: 'close-up',
    optional:    true,
    bonus:       true,
  },
}

// ── Priority scores ─────────────────────────────────────────────────────────
// Higher = survives budget cuts first.
// Interior and exterior scores overlap so complete-detail budgets are
// allocated across both based on value, not category.

const SCORES: Record<string, number> = {
  interior_front_driver:    100,
  exterior_driver_side:      95,
  interior_front_passenger:  90,
  exterior_passenger_side:   88,
  interior_console:          85,
  exterior_truck_bed:        82,
  interior_rear_driver:      80,
  exterior_front:            78,
  interior_rear_passenger:   70,
  exterior_rear:             68,
  interior_third_row:        60,
  interior_cargo:            55,
  interior_trunk:            50,
  interior_worst_area:       40,
  exterior_worst_area:       38,
}

// ── Physical walk-around order ──────────────────────────────────────────────
// Returns the capture sequence that minimizes backtracking for each vehicle type.
//
// Trucks: bed immediately after driver-rear — employee is already at the back.
// SUVs/vans: cargo immediately after third row — already at the open hatch.
// Exterior walk-around is the same for all types.

function getOrderedRoles(layout: VehicleLayout): string[] {
  if (layout.hasTruckBed) {
    // Open the tailgate while standing at the driver rear, then continue around
    // to passenger rear before moving to the passenger front.
    return [
      'interior_front_driver',
      'interior_rear_driver',
      'exterior_truck_bed',        // employee is at the back — grab the bed here
      'interior_rear_passenger',
      'interior_front_passenger',
      'interior_console',
      'interior_worst_area',
      'exterior_front',
      'exterior_driver_side',
      'exterior_rear',
      'exterior_passenger_side',
      'exterior_worst_area',
    ]
  }

  // All other vehicles: cargo/trunk after reaching the rear of the vehicle
  return [
    'interior_front_driver',
    'interior_rear_driver',
    'interior_third_row',    // SUV/van: continue to third row
    'interior_cargo',        // open hatch while at the back
    'interior_trunk',        // sedan: pop the trunk while at the rear
    'interior_rear_passenger',
    'interior_front_passenger',
    'interior_console',
    'interior_worst_area',
    'exterior_front',
    'exterior_driver_side',
    'exterior_rear',
    'exterior_passenger_side',
    'exterior_worst_area',
  ]
}

// ── Builder ─────────────────────────────────────────────────────────────────

export function buildPhotoSteps(
  layout:       VehicleLayout,
  serviceFocus: string | null
): PhotoStep[] {
  const needsInterior = serviceFocus !== 'exterior_only'
  const needsExterior = serviceFocus !== 'interior_only'

  const candidates: { step: PhotoStep; score: number }[] = []

  function add(role: string) {
    const step = STEPS[role]
    if (step) candidates.push({ step, score: SCORES[role] ?? 0 })
  }

  if (needsInterior) {
    add('interior_front_driver')
    add('interior_front_passenger')
    add('interior_console')
    if (layout.hasRearSeats) {
      add('interior_rear_driver')
      add('interior_rear_passenger')
    }
    if (layout.hasThirdRow)  add('interior_third_row')
    if (layout.hasCargoArea) add('interior_cargo')
    if (layout.hasTrunk)     add('interior_trunk')
    add('interior_worst_area')
  }

  if (needsExterior) {
    add('exterior_driver_side')
    add('exterior_passenger_side')
    add('exterior_front')
    add('exterior_rear')
    if (layout.hasTruckBed) add('exterior_truck_bed')
    add('exterior_worst_area')
  }

  // Select highest-value shots within budget
  const selected = new Set(
    candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PHOTOS)
      .map(c => c.step.role)
  )

  // Re-order by physical walk-around path (layout-aware)
  return getOrderedRoles(layout)
    .filter(role => selected.has(role))
    .map(role => STEPS[role])
    .filter((s): s is PhotoStep => !!s)
}
