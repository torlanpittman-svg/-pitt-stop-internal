import type { WorkflowStatus } from '@/platform/status'

export interface VehicleData {
  year: string | null
  make: string | null
  model: string | null
  color: string | null
  customColor?: string | null
  stockNumber: string | null
}

export interface OCRConfidence {
  year: number
  make: number
  model: number
  color: number
  stockNumber: number
}

export interface VehicleOCRResult extends VehicleData {
  confidence: OCRConfidence
  rawResponse: unknown
  providerName: string
}

export type VehicleEntryStatus =
  | WorkflowStatus
  | 'pending_quickbooks'
  | 'ready_for_quickbooks'
  | 'quickbooks_updated'
  | 'quickbooks_error'

export interface VehicleEntry {
  id: string
  createdAt: Date
  updatedAt: Date
  photoUrl: string
  year: string | null
  make: string | null
  model: string | null
  color: string | null
  customColor: string | null
  stockNumber: string | null
  ocrConfidence: OCRConfidence | null
  rawOcrResponse: unknown
  wasCorrected: boolean
  status: VehicleEntryStatus
  quickbooksInvoiceId: string | null
}
