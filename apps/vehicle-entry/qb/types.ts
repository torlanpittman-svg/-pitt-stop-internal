// QuickBooks provider interface — same shape for mock (Phase 1) and live (Phase 3).

export interface QBLine {
  id:          string
  description: string
  amount:      number
}

export interface QBInvoice {
  id:            string
  invoiceNumber: string
  customerId:    string
  syncToken:     string   // QB uses string tokens; mock uses "1", "2", etc.
  lines:         QBLine[]
}

export interface QBProvider {
  fetchInvoice(invoiceId: string): Promise<QBInvoice>

  addLineToInvoice(params: {
    invoiceId:   string
    syncToken:   string
    description: string
  }): Promise<{ lineId: string; newSyncToken: string }>

  createInvoice(params: {
    customerId:  string
    customerName?: string
    invoiceNumber: string
  }): Promise<{ invoiceId: string; invoiceNumber: string; syncToken: string }>
}
