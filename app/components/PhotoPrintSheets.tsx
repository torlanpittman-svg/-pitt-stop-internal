import type { OrderPhoto } from '@/apps/order-photos/types'

export interface PhotoPacketDetails {
  customer: string
  vehicle: string
  vin: string | null
  orderNumber: string
  invoiceNumber?: string | null
  estimateNumber?: string | null
}

export default function PhotoPrintSheets({ photos, details }: { photos: OrderPhoto[]; details: PhotoPacketDetails }) {
  const selected = photos.filter((photo) => photo.included)
  return <div>
    <style>{`
      @page { size: auto; margin: 15mm; }
      .photo-sheet { margin-top: 28px; padding-top: 16px; border-top: 2px solid #111; break-inside: avoid; }
      .photo-evidence { width: 100%; max-height: 620px; object-fit: contain; margin: 16px 0; }
      @media print {
        html, body { height: auto !important; background: white !important; color: black !important; }
        .photo-document { padding: 0 !important; min-height: 0 !important; }
        .photo-print-controls { display: none !important; }
        .photo-sheet { break-before: page; margin-top: 0; padding-top: 0; }
        .photo-packet-only .photo-sheet:first-child { break-before: auto; }
        .photo-evidence { max-height: 6.4in; }
      }
    `}</style>
    {selected.map((photo, index) => <section className="photo-sheet" key={photo.id}>
      <h2 style={{ margin: '8px 0', fontSize: 22 }}>Pitt Stop — Vehicle photos</h2>
      <p style={{ margin: '4px 0', fontWeight: 600 }}>{details.customer} · {details.vehicle}</p>
      <p style={{ margin: '4px 0', fontSize: 13 }}>VIN: {details.vin || 'Not recorded'} · Order: {details.orderNumber}</p>
      {(details.estimateNumber || details.invoiceNumber) && <p style={{ margin: '4px 0', fontSize: 13 }}>
        {[details.estimateNumber && `Estimate #${details.estimateNumber}`, details.invoiceNumber && `Invoice #${details.invoiceNumber}`].filter(Boolean).join(' · ')}
      </p>}
      <p style={{ fontSize: 12, color: '#555', margin: '6px 0' }}>Photo {index + 1} of {selected.length} · Uploaded {new Date(photo.createdAt).toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}{photo.resized ? ' · Resized copy' : ''}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.imageUrl} alt={photo.caption || photo.filename} className="photo-evidence" />
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14 }}>{photo.caption || photo.filename}</p>
    </section>)}
  </div>
}
