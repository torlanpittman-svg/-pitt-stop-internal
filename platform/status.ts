/**
 * Base workflow status type shared across all modules.
 *
 * Each module extends this with its own integration-specific statuses.
 * Using a shared base prevents the same concepts from getting
 * different names across modules (e.g. "pending" vs "draft" vs "unconfirmed").
 *
 * Vehicle Entry extends this with QuickBooks statuses.
 * Estimator will extend this with customer-facing statuses.
 */
export type WorkflowStatus =
  | 'draft'         // Record created but employee has not confirmed yet
  | 'confirmed'     // Employee confirmed the extracted/entered data
  | 'needs_review'  // Flagged — low confidence, error, or manual flag
  | 'processing'    // A background operation (sync, send) is in progress

/**
 * Standard status labels for display in admin UI.
 * Modules can extend or override for their own statuses.
 */
export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  needs_review: 'Needs Review',
  processing: 'Processing',
  // Vehicle Entry additions
  ready_for_quickbooks:       'Ready for QB',
  quickbooks_updated:         'QB Updated',
  quickbooks_error:           'QB Error',
  pending_quickbooks:         'Pending QB',
  pending_invoice_assignment: 'Pending Invoice',
  // Estimator additions (future)
  sent_to_customer: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
}

export const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-700 text-gray-300',
  confirmed: 'bg-green-900 text-green-300',
  needs_review: 'bg-yellow-900 text-yellow-300',
  processing: 'bg-blue-900 text-blue-300',
  ready_for_quickbooks: 'bg-blue-900 text-blue-300',
  quickbooks_updated: 'bg-green-900 text-green-300',
  quickbooks_error: 'bg-red-900 text-red-300',
  pending_quickbooks:         'bg-gray-700 text-gray-300',
  pending_invoice_assignment: 'bg-orange-900 text-orange-300',
  sent_to_customer: 'bg-blue-900 text-blue-300',
  accepted: 'bg-green-900 text-green-300',
  declined: 'bg-red-900 text-red-300',
}
