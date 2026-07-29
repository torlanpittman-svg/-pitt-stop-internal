export const metadata = { title: 'Privacy Policy — Pitt Stop OS' }

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-6 py-12">
      <div className="max-w-2xl mx-auto prose-invert">
        <h1 className="text-2xl font-bold text-white mb-2">Privacy Policy</h1>
        <p className="text-gray-500 text-sm mb-8">Last updated: 2026-07-29</p>

        <p className="mb-4">
          Pitt Stop OS (“the App”) is an internal operations tool used by Pitt Stop
          (“we”, “us”) to manage vehicle check-ins, work tracking, and invoicing.
          This policy explains what data the App handles and how.
        </p>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">Information we process</h2>
        <ul className="list-disc pl-5 space-y-1 text-gray-300">
          <li>Vehicle details (VIN, year, make, model, color, stock number) captured during check-in.</li>
          <li>Dealership and customer records, invoices, and line items retrieved from or written to QuickBooks Online.</li>
          <li>QuickBooks OAuth tokens, stored encrypted at rest and used only to call the QuickBooks API on our behalf.</li>
          <li>Operational metadata (timestamps, scan and sync status) used to run and monitor the workflow.</li>
        </ul>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">How we use it</h2>
        <p className="mb-4 text-gray-300">
          Data is used solely to operate Pitt Stop’s business: creating and updating
          invoices in QuickBooks, tracking vehicles on the work board, and reporting.
          We do not sell data or share it with third parties except the services
          required to run the App (QuickBooks/Intuit, our hosting and database providers).
        </p>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">QuickBooks / Intuit</h2>
        <p className="mb-4 text-gray-300">
          The App connects to QuickBooks Online via Intuit’s OAuth 2.0. Access and
          refresh tokens are encrypted and can be revoked at any time by disconnecting
          the integration in the App or from within QuickBooks. Revoking removes the
          App’s ability to access the connected company.
        </p>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">Data retention & security</h2>
        <p className="mb-4 text-gray-300">
          Records are retained for as long as needed for business and accounting
          purposes. Tokens are encrypted (AES-256-GCM). Access is limited to authorized
          Pitt Stop staff.
        </p>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">Contact</h2>
        <p className="text-gray-300">Questions: torlanpittman@gmail.com</p>
      </div>
    </main>
  )
}
