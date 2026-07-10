/**
 * Static diagnostic page — no database, no JavaScript required.
 * Purpose: verify that Next.js routing reaches the confirm page at all.
 * If you can open this URL on mobile, routing works.
 */
export default function TestConfirmPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0a0a0a',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
      }}
    >
      <div
        style={{
          background: '#16a34a',
          borderRadius: '1rem',
          padding: '1.5rem',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>✓</div>
        <div style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>
          Routing works!
        </div>
        <div style={{ color: '#bbf7d0', marginTop: '0.5rem' }}>
          This page loaded without JavaScript.
        </div>
      </div>

      <div
        style={{
          background: '#1f2937',
          borderRadius: '1rem',
          padding: '1.5rem',
          fontSize: '0.875rem',
          color: '#9ca3af',
        }}
      >
        <div style={{ color: '#fff', fontWeight: '600', marginBottom: '0.75rem' }}>
          What this means:
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, lineHeight: '2' }}>
          <li>✓ Next.js server is running</li>
          <li>✓ App Router routing works</li>
          <li>✓ Confirm page path is reachable</li>
          <li>✓ Mobile browser can reach this URL</li>
        </ul>
      </div>

      <a
        href="/vehicle-entry"
        style={{
          display: 'block',
          background: '#2563eb',
          borderRadius: '1rem',
          padding: '1.25rem',
          textAlign: 'center',
          color: '#fff',
          fontWeight: '600',
          textDecoration: 'none',
          fontSize: '1rem',
        }}
      >
        ← Back to Vehicle Entry
      </a>
    </main>
  )
}
