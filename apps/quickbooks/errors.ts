/** Typed errors for the QuickBooks integration, so callers can branch cleanly. */

/** No active connection exists — the company has never been connected. */
export class QBNotConnectedError extends Error {
  code = 'qb_not_connected' as const
  constructor(message = 'QuickBooks is not connected.') {
    super(message)
    this.name = 'QBNotConnectedError'
  }
}

/** The refresh token expired or was revoked — an admin must reconnect. */
export class QBReauthRequiredError extends Error {
  code = 'qb_reauth_required' as const
  constructor(message = 'QuickBooks connection expired. Please reconnect.') {
    super(message)
    this.name = 'QBReauthRequiredError'
  }
}

/** A QuickBooks API call failed after a valid token was obtained. */
export class QBApiError extends Error {
  code = 'qb_api_error' as const
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'QBApiError'
    this.status = status
  }
}
