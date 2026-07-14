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
  modelName: string
  promptVersion: string
  // Stock number pipeline outputs
  stockCropBase64: string | null           // padded crop (null if no valid box)
  stockCropMimeType: string
  stockDebugOverlayBase64: string | null   // original image with bounding boxes drawn
  stockDebugData: Record<string, unknown> | null  // diagnostic info (predictions, boxes, source)
}

export type VehicleEntryStatus =
  | WorkflowStatus
  | 'pending_quickbooks'
  | 'ready_for_quickbooks'
  | 'quickbooks_updated'
  | 'quickbooks_error'
  | 'pending_invoice_assignment'

export type SyncOutcome = {
  outcome:        'synced' | 'pending_invoice_assignment' | 'needs_review' | 'error'
  invoiceNumber:  string | null
  dealershipName: string | null
  lineText:       string | null
  reason:         string | null
}

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
  stockNumberCropUrl: string | null
  stockNumberAiPrediction: string | null
  stockDebugOverlayUrl: string | null
  stockDebugData: Record<string, unknown> | null
  ocrConfidence: OCRConfidence | null
  rawOcrResponse: unknown
  wasCorrected: boolean
  status: VehicleEntryStatus
  quickbooksInvoiceId: string | null
}
