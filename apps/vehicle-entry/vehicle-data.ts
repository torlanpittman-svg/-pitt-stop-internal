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
  // ── GM ──────────────────────────────────────────────────────────────────────
  Buick: [
    'Enclave', 'Encore', 'Encore GX', 'Envision', 'Envista',
    'LaCrosse', 'Verano', 'Regal', 'Cascada',
  ],
  Cadillac: [
    'CT4', 'CT5', 'CTS', 'ATS', 'XTS',
    'Escalade', 'Escalade ESV',
    'XT4', 'XT5', 'XT6',
    'LYRIQ', 'CELESTIQ',
  ],
  Chevrolet: [
    'Silverado 1500', 'Silverado 2500HD', 'Silverado 3500HD',
    'Tahoe', 'Suburban', 'Traverse', 'Blazer', 'Equinox', 'Trailblazer', 'Trax',
    'Camaro', 'Corvette',
    'Malibu', 'Impala', 'Spark',
    'Colorado', 'Bolt EV', 'Bolt EUV',
  ],
  GMC: [
    'Sierra 1500', 'Sierra 2500HD', 'Sierra 3500HD',
    'Yukon', 'Yukon XL',
    'Acadia', 'Terrain', 'Envoy',
    'Canyon', 'Hummer EV', 'Hummer EV SUV',
  ],

  // ── Ford Motor Company ───────────────────────────────────────────────────────
  Ford: [
    'F-150', 'F-250 Super Duty', 'F-350 Super Duty', 'F-450 Super Duty', 'Maverick', 'Ranger',
    'Explorer', 'Expedition', 'Escape', 'Edge', 'Bronco', 'Bronco Sport', 'EcoSport',
    'Mustang', 'Mustang Mach-E',
    'Transit', 'Transit Connect', 'Transit-150',
    'F-150 Lightning',
  ],
  Lincoln: [
    'Navigator', 'Navigator L',
    'Aviator', 'Corsair', 'Nautilus',
    'MKZ', 'MKC', 'MKT', 'MKX',
    'Continental', 'Town Car',
  ],

  // ── Stellantis ────────────────────────────────────────────────────────────────
  'Alfa Romeo': [
    'Giulia', 'Stelvio', 'Tonale', 'Giulietta',
  ],
  Chrysler: [
    '300', 'Pacifica', 'Pacifica Hybrid', 'Voyager',
    'Town & Country', 'Aspen', 'Sebring', '200',
  ],
  Dodge: [
    'Charger', 'Challenger', 'Durango',
    'Journey', 'Grand Caravan', 'Hornet',
    'Viper', 'Dart',
  ],
  Fiat: [
    '500', '500X', '500L', '500e',
  ],
  Jeep: [
    'Wrangler', 'Wrangler Unlimited',
    'Grand Cherokee', 'Grand Cherokee L', 'Grand Wagoneer', 'Wagoneer',
    'Cherokee', 'Compass', 'Renegade', 'Gladiator', 'Avenger',
  ],
  Maserati: [
    'Ghibli', 'Quattroporte', 'Levante', 'Grecale', 'GranTurismo', 'GranCabrio', 'MC20',
  ],
  Ram: [
    '1500', '1500 Classic', '2500', '3500',
    'ProMaster', 'ProMaster City',
  ],

  // ── Toyota Motor Corporation ─────────────────────────────────────────────────
  Lexus: [
    'ES', 'IS', 'GS', 'LS', 'RC', 'LC',
    'NX', 'RX', 'GX', 'LX', 'UX',
    'RZ', 'TX',
  ],
  Toyota: [
    'Camry', 'Corolla', 'Corolla Cross', 'Avalon', 'Prius', 'Prius Prime',
    'Tacoma', 'Tundra', 'Sequoia',
    '4Runner', 'Highlander', 'RAV4', 'RAV4 Prime', 'Venza', 'C-HR',
    'Sienna', 'Land Cruiser',
    'bZ4X', 'GR Supra', 'GR86', 'GR Corolla',
  ],

  // ── Honda Motor Company ──────────────────────────────────────────────────────
  Acura: [
    'MDX', 'RDX', 'TLX', 'Integra', 'NSX',
    'ILX', 'RLX', 'TSX', 'ZDX',
  ],
  Honda: [
    'Accord', 'Civic', 'Insight', 'CR-Z',
    'CR-V', 'HR-V', 'Pilot', 'Passport',
    'Odyssey', 'Ridgeline',
    'Prologue', 'e:NY1',
  ],

  // ── Hyundai Motor Group ──────────────────────────────────────────────────────
  Genesis: [
    'G70', 'G80', 'G90',
    'GV70', 'GV80', 'GV90',
    'Electrified G80', 'Electrified GV70',
  ],
  Hyundai: [
    'Elantra', 'Elantra N', 'Sonata', 'Azera', 'Veloster',
    'Santa Fe', 'Tucson', 'Palisade', 'Kona', 'Venue',
    'Ioniq 5', 'Ioniq 6', 'Ioniq', 'Nexo',
    'Accent', 'Santa Cruz',
  ],
  Kia: [
    'K5', 'Optima', 'Stinger', 'Forte', 'Rio',
    'Sorento', 'Sportage', 'Telluride', 'Soul', 'Niro', 'Seltos',
    'Carnival', 'EV6', 'EV9',
  ],

  // ── Nissan Motor Company ─────────────────────────────────────────────────────
  Infiniti: [
    'Q50', 'Q60', 'QX50', 'QX55', 'QX60', 'QX80',
    'M37', 'M56', 'G37', 'G35', 'FX35', 'FX50', 'JX35',
  ],
  Nissan: [
    'Altima', 'Maxima', 'Sentra', 'Versa',
    'Rogue', 'Rogue Sport', 'Pathfinder', 'Murano', 'Kicks', 'Armada',
    'Frontier', 'Titan', 'Titan XD',
    'LEAF', 'Ariya', '400Z',
  ],

  // ── Volkswagen Group ─────────────────────────────────────────────────────────
  Audi: [
    'A3', 'A4', 'A4 Allroad', 'A5', 'A6', 'A6 Allroad', 'A7', 'A8',
    'S3', 'S4', 'S5', 'S6', 'S7', 'S8',
    'RS 3', 'RS 5', 'RS 6', 'RS 7', 'RS e-tron GT',
    'Q3', 'Q4 e-tron', 'Q5', 'Q7', 'Q8', 'Q8 e-tron', 'SQ5', 'SQ7', 'SQ8',
    'TT', 'TTS', 'TT RS', 'R8', 'e-tron GT',
  ],
  Porsche: [
    '911', '718 Boxster', '718 Cayman', '718 Spyder',
    'Panamera', 'Macan', 'Cayenne', 'Taycan',
    'Cayenne Coupe', 'Panamera Sport Turismo',
  ],
  Volkswagen: [
    'Jetta', 'Jetta GLI', 'Passat', 'Arteon',
    'Tiguan', 'Atlas', 'Atlas Cross Sport', 'Taos',
    'Golf', 'Golf GTI', 'Golf R',
    'ID.4', 'ID.3',
  ],

  // ── BMW Group ────────────────────────────────────────────────────────────────
  BMW: [
    '2 Series', '3 Series', '4 Series', '5 Series', '7 Series', '8 Series',
    'M2', 'M3', 'M4', 'M5', 'M8',
    'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'XM',
    'i3', 'i4', 'i5', 'i7', 'iX', 'iX1', 'iX3',
  ],
  MINI: [
    'Cooper', 'Cooper S', 'Cooper SE',
    'Countryman', 'Clubman', 'Paceman', 'Convertible', 'Roadster',
    'John Cooper Works',
  ],

  // ── Mercedes-Benz Group ──────────────────────────────────────────────────────
  'Mercedes-Benz': [
    'A-Class', 'C-Class', 'E-Class', 'S-Class', 'CLA', 'CLS',
    'GLA', 'GLB', 'GLC', 'GLE', 'GLS', 'G-Class',
    'AMG GT', 'SL', 'SLS',
    'EQA', 'EQB', 'EQC', 'EQE', 'EQE SUV', 'EQS', 'EQS SUV',
    'Metris', 'Sprinter',
  ],

  // ── Volvo / Polestar ─────────────────────────────────────────────────────────
  Polestar: [
    'Polestar 2', 'Polestar 3', 'Polestar 4', 'Polestar 6',
  ],
  Volvo: [
    'S60', 'S90',
    'V60', 'V60 Cross Country', 'V90', 'V90 Cross Country',
    'XC40', 'XC40 Recharge', 'XC60', 'XC90',
    'C40 Recharge',
  ],

  // ── Subaru ───────────────────────────────────────────────────────────────────
  Subaru: [
    'Outback', 'Forester', 'Crosstrek', 'Ascent',
    'Legacy', 'Impreza', 'WRX', 'BRZ',
    'Solterra',
  ],

  // ── Mazda ────────────────────────────────────────────────────────────────────
  Mazda: [
    'Mazda3', 'Mazda6',
    'CX-5', 'CX-30', 'CX-50', 'CX-70', 'CX-90', 'CX-9',
    'MX-5 Miata', 'MX-30',
  ],

  // ── Mitsubishi ───────────────────────────────────────────────────────────────
  Mitsubishi: [
    'Outlander', 'Outlander PHEV', 'Outlander Sport',
    'Eclipse Cross', 'Mirage', 'Mirage G4', 'Galant',
  ],

  // ── Jaguar Land Rover ─────────────────────────────────────────────────────────
  Jaguar: [
    'F-Pace', 'E-Pace', 'I-Pace',
    'F-Type', 'XE', 'XF', 'XJ',
  ],
  'Land Rover': [
    'Range Rover', 'Range Rover Sport', 'Range Rover Velar', 'Range Rover Evoque',
    'Defender', 'Discovery', 'Discovery Sport',
  ],

  // ── EV / New Brands ──────────────────────────────────────────────────────────
  Lucid: [
    'Lucid Air', 'Lucid Gravity',
  ],
  Rivian: [
    'R1T', 'R1S', 'R2', 'R3',
  ],
  Tesla: [
    'Model 3', 'Model Y', 'Model S', 'Model X', 'Cybertruck',
  ],

  // ── Exotic / Ultra-Luxury ────────────────────────────────────────────────────
  'Aston Martin': [
    'DB12', 'DBX', 'DBX707', 'Vantage', 'DBS', 'Vanquish',
  ],
  Bentley: [
    'Continental GT', 'Continental GTC', 'Bentayga', 'Flying Spur', 'Mulsanne',
  ],
  Ferrari: [
    '296 GTB', '296 GTS', 'SF90 Stradale', 'SF90 Spider',
    'Roma', 'Roma Spider', 'Portofino M',
    'F8 Tributo', 'F8 Spider', '812 Superfast', '812 GTS',
    'Purosangue', 'Daytona SP3',
  ],
  Lamborghini: [
    'Huracán', 'Huracán Evo', 'Huracán Sterrato',
    'Urus', 'Urus Performante', 'Urus S',
    'Revuelto',
  ],
  'Rolls-Royce': [
    'Ghost', 'Ghost Extended', 'Phantom', 'Phantom Extended',
    'Cullinan', 'Wraith', 'Dawn', 'Spectre',
  ],
}

export const MAKES = Object.keys(MAKES_AND_MODELS).sort()

export function getModelsForMake(make: string): string[] {
  return MAKES_AND_MODELS[make] ?? []
}
