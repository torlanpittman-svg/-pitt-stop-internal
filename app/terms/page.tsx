export const metadata = { title: 'Terms of Service — Pitt Stop OS' }

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-gray-950 text-gray-200 px-6 py-12">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-white mb-2">Terms of Service &amp; End User License Agreement</h1>
        <p className="text-gray-500 text-sm mb-8">Last updated: 2026-07-29</p>

        <p className="mb-4">
          Pitt Stop OS (“the App”) is proprietary internal software operated by Pitt Stop
          for its own business operations. By using the App you agree to these terms.
        </p>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">License</h2>
        <p className="mb-4 text-gray-300">
          The App is provided for authorized Pitt Stop staff only. No license is granted
          to copy, redistribute, or use the App outside Pitt Stop’s operations.
        </p>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">QuickBooks integration</h2>
        <p className="mb-4 text-gray-300">
          The App connects to QuickBooks Online to read and write invoices, customers,
          and related records on behalf of the connected company. You are responsible for
          the accuracy of data entered and for the QuickBooks account you connect. You may
          disconnect at any time, which revokes the App’s access.
        </p>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">Acceptable use</h2>
        <p className="mb-4 text-gray-300">
          Use the App only for legitimate Pitt Stop business. Do not attempt to access
          data you are not authorized to view or to disrupt the service.
        </p>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">Disclaimer &amp; liability</h2>
        <p className="mb-4 text-gray-300">
          The App is provided “as is” without warranties of any kind. To the maximum
          extent permitted by law, Pitt Stop is not liable for indirect or consequential
          damages arising from use of the App. QuickBooks is a trademark of Intuit Inc.;
          Pitt Stop OS is not affiliated with or endorsed by Intuit.
        </p>

        <h2 className="text-lg font-semibold text-white mt-8 mb-2">Contact</h2>
        <p className="text-gray-300">Questions: torlanpittman@gmail.com</p>
      </div>
    </main>
  )
}
