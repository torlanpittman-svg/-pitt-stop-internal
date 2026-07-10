/**
 * Vehicle Entry — reference data for dropdown fields.
 * This data is specific to this app and lives here, not in platform/.
 */

export const YEARS: string[] = Array.from(
  { length: 2026 - 2000 + 1 },
  (_, i) => String(2026 - i)
)

export const COLORS = [
  'Black', 'White', 'Silver', 'Gray', 'Red', 'Blue',
  'Green', 'Brown', 'Tan', 'Gold', 'Orange', 'Yellow', 'Purple',
  'Other',
] as const

export type Color = (typeof COLORS)[number]

export const MAKES_AND_MODELS: Record<string, string[]> = {
  Ford:           ['F-150', 'F-250', 'F-350', 'Explorer', 'Expedition', 'Mustang', 'Escape', 'Edge', 'Fusion'],
  Chevrolet:      ['Silverado', 'Tahoe', 'Suburban', 'Malibu', 'Impala', 'Equinox', 'Traverse', 'Camaro', 'Corvette'],
  GMC:            ['Sierra', 'Yukon', 'Yukon XL', 'Acadia', 'Terrain', 'Canyon'],
  Toyota:         ['Camry', 'Corolla', 'Tacoma', 'Tundra', '4Runner', 'Highlander', 'RAV4', 'Avalon', 'Sienna'],
  Honda:          ['Accord', 'Civic', 'CR-V', 'Pilot', 'Odyssey', 'Ridgeline'],
  Nissan:         ['Altima', 'Maxima', 'Sentra', 'Rogue', 'Pathfinder', 'Frontier', 'Titan', 'Murano'],
  Hyundai:        ['Elantra', 'Sonata', 'Santa Fe', 'Tucson', 'Palisade', 'Genesis'],
  Kia:            ['Optima', 'K5', 'Forte', 'Sorento', 'Sportage', 'Telluride', 'Soul'],
  Dodge:          ['Charger', 'Challenger', 'Durango', 'Journey', 'Grand Caravan'],
  Ram:            ['1500', '2500', '3500', 'ProMaster'],
  Jeep:           ['Wrangler', 'Grand Cherokee', 'Cherokee', 'Compass', 'Renegade', 'Gladiator'],
  Cadillac:       ['Escalade', 'CTS', 'ATS', 'XT4', 'XT5', 'XT6', 'CT4', 'CT5'],
  Lexus:          ['ES', 'IS', 'GS', 'LS', 'RX', 'GX', 'LX', 'NX'],
  BMW:            ['3 Series', '5 Series', '7 Series', 'X3', 'X5', 'X7'],
  'Mercedes-Benz': ['C-Class', 'E-Class', 'S-Class', 'GLC', 'GLE', 'GLS'],
}

export const MAKES = Object.keys(MAKES_AND_MODELS).sort()

export function getModelsForMake(make: string): string[] {
  return MAKES_AND_MODELS[make] ?? []
}
