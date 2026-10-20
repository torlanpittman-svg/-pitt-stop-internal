/**
 * Scan VIN (Edit Vehicle) — interprets the EXISTING VIN reader's answer (/api/estimator/vin: image →
 * VIN read → check-digit validation → canonical NHTSA decode). Pure, so the safety rules are tested:
 *   • a VIN is only put in the field when it passes validation — an unreadable or failing read never
 *     replaces the VIN on file, and no character is ever guessed or "fixed" here;
 *   • a failing read is offered as a REVIEW candidate the manager can choose to correct;
 *   • the decoded year/make/model go through the form's normal decode handling (fill blanks, confirm
 *     before replacing different details) — nothing is saved until "Save correction".
 */
import type { VinDecodeResult } from '@/app/hooks/useVinDecode'

export type VinScanOutcome =
  | { kind: 'decoded'; vin: string; decode: VinDecodeResult }
  | { kind: 'review'; candidate: string; message: string }
  | { kind: 'unreadable'; message: string }

interface ReaderResponse {
  vin?: string | null; valid?: boolean; year?: string | null; make?: string | null; model?: string | null
  error?: string; message?: string
}

const VIN_SHAPE = /^[A-HJ-NPR-Z0-9]{17}$/

export function interpretVinScan(httpOk: boolean, body: ReaderResponse | null): VinScanOutcome {
  const vin = typeof body?.vin === 'string' ? body.vin.trim().toUpperCase() : ''
  if (httpOk && body?.valid === true && VIN_SHAPE.test(vin)) {
    const decoded = !!(body.make || body.year)
    return {
      kind: 'decoded', vin,
      decode: {
        ok: decoded, valid: true, vin, year: body.year ?? null, make: body.make ?? null, model: body.model ?? null,
        error: decoded ? undefined : "VIN read ✓ but vehicle details couldn't be decoded — check them manually.",
      },
    }
  }
  if (httpOk && vin) {
    return { kind: 'review', candidate: vin, message: body?.message || 'We may have misread one or more characters. Check it against the vehicle before using it.' }
  }
  return { kind: 'unreadable', message: body?.error || 'Could not read a VIN from that photo. Retake it closer, or type the VIN.' }
}
