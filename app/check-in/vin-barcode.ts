/**
 * Free, client-side VIN barcode read (no AI). Reused by the Smart Check-In intake as a zero-cost
 * first-pass: a scannable 17-char VIN barcode means it's a real VIN label (retail). Uses the native
 * BarcodeDetector where available (Android Chrome); returns null on browsers without it (e.g. iOS
 * Safari), where the intake falls back to AI OCR. Mirrors the helper in the legacy CheckInFlow.
 */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/
const BARCODE_FORMATS = ['code_39', 'code_128', 'qr_code', 'data_matrix', 'pdf417']

function cleanVin(raw: string): string { return raw.replace(/[^A-HJ-NPR-Z0-9]/gi, '').toUpperCase() }

/** Try to read a valid 17-char VIN barcode from an image blob. Never throws → null when unavailable. */
export async function vinFromBarcode(source: Blob): Promise<string | null> {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detector = new (window as any).BarcodeDetector({ formats: BARCODE_FORMATS })
    const bitmap = await createImageBitmap(source)
    const barcodes = await detector.detect(bitmap)
    for (const bc of barcodes) {
      const raw = cleanVin(bc.rawValue)
      if (VIN_RE.test(raw)) return raw
    }
  } catch { /* unsupported or no barcode present */ }
  return null
}
