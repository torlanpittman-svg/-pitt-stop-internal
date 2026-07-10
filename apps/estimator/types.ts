/**
 * Estimator — Module 2 (placeholder)
 *
 * Follows the same pattern as Vehicle Entry:
 *   photo/input → AI analysis → employee confirmation → saved record → admin review
 *
 * All fields are provisional — finalize during module design.
 */

import type { WorkflowStatus } from '@/platform/status'

export interface EstimateLineItem {
  description: string
  partCost: number | null
  laborHours: number | null
  laborRate: number | null
}

export interface EstimateData {
  vehicleYear: string | null
  vehicleMake: string | null
  vehicleModel: string | null
  stockNumber: string | null
  damageDescription: string | null
  lineItems: EstimateLineItem[]
  totalEstimate: number | null
}

export type EstimateStatus =
  | WorkflowStatus
  | 'sent_to_customer'
  | 'accepted'
  | 'declined'

export interface EstimateEntry {
  id: string
  createdAt: Date
  updatedAt: Date
  photoUrl: string
  data: EstimateData
  aiConfidence: Record<string, number> | null
  rawAiResponse: unknown
  wasCorrected: boolean
  status: EstimateStatus
}
