import type { VisionQueryOptions, VisionQueryResult } from '../index'

/**
 * Mock AI vision provider for local demo testing.
 * Returns realistic vehicle data with mixed confidence scores
 * so you can see the full UI flow including low-confidence indicators.
 *
 * Activated automatically when no API key is configured,
 * or explicitly with OCR_PROVIDER=mock.
 */

const MOCK_VEHICLES = [
  { year: '2020', make: 'Ford',       model: 'F-150',     color: 'Silver'  },
  { year: '2019', make: 'Chevrolet',  model: 'Silverado', color: 'Black'   },
  { year: '2021', make: 'Toyota',     model: 'Tacoma',    color: 'White'   },
  { year: '2018', make: 'GMC',        model: 'Sierra',    color: 'Gray'    },
  { year: '2022', make: 'Ram',        model: '1500',      color: 'Red'     },
]

export async function queryWithMock(
  _options: VisionQueryOptions
): Promise<VisionQueryResult> {
  // Simulate AI processing time
  await new Promise((r) => setTimeout(r, 1200))

  const v = MOCK_VEHICLES[Math.floor(Math.random() * MOCK_VEHICLES.length)]
  const stockNumber = `PS${String(Math.floor(1000 + Math.random() * 9000))}`

  // Intentionally mix confidence levels to demo the UI indicators:
  // stock number is medium-confidence to show the yellow warning
  const response = {
    year:        v.year,
    make:        v.make,
    model:       v.model,
    color:       v.color,
    stockNumber,
    confidence: {
      year:        0.97,
      make:        0.95,
      model:       0.89,
      color:       0.91,
      stockNumber: 0.71,
    },
  }

  return {
    content:      JSON.stringify(response),
    rawResponse:  response,
    providerName: 'mock',
    modelName:    'mock',
  }
}
