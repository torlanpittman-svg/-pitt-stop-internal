# Vehicle photos on estimates and jobs

The estimate's vehicle information contains one optional **Add photos** button. It opens the phone's native photo picker, where the user can take a picture or choose existing pictures. Selected pictures save immediately and appear as small thumbnails. Tap a thumbnail to open it, or its × to remove it. There are no note fields, selection checkboxes, separate save steps, or packet controls in the estimate workflow.

Photos remain on the same service order when a standalone estimate moves to the Work Board and through completion/invoicing. The job uses the same compact photo control. Added photos are appended to the existing estimate printout automatically. This does not automatically attach files to QuickBooks records or customer emails.

## Release

1. Apply `drizzle/migrations/manual/0045_order_photos.sql` to the target database before deployment. The migration creates only the new `order_photos` table and its indexes; it can be run again safely.
2. Provide a private Vercel Blob store credential using `ORDER_PHOTOS_BLOB_READ_WRITE_TOKEN`, or reuse the existing private `RECEIPTS_BLOB_READ_WRITE_TOKEN` store. Photos use their own `order-photos/` namespace. The public `BLOB_READ_WRITE_TOKEN` is never a fallback.
3. Deploy the application. Confirm Add photos, refresh, thumbnail open/removal, and estimate printing using a test vehicle. Check the same photos after moving a standalone estimate to the Work Board.

## Storage and access

- Listing, uploading, editing, downloading, and printing require a signed manager/admin identity. Every photo read/update is scoped to its service order. Clients receive authenticated application URLs, never private storage credentials or reusable Blob URLs.
- The server accepts JPEG, PNG, and WebP up to 4 MiB after checking signatures and fully decoding the image. Corrupt images, animated images, and decoded images over 40 million pixels are rejected. HEIC/HEIF input is converted when the browser supports decoding it; otherwise the user is prompted to export JPEG.
- Normal-size files are preserved byte-for-byte. The client makes a 2560-pixel JPEG copy for files above the server limit or HEIC/HEIF input and records when a copy was resized. It rejects source files above 30 MiB. Uploads are sequential to stay under the hosting request limit. Failed files can be retried as a batch without repeating successful uploads.
- Original file EXIF timestamps are not presented as evidence of when damage occurred. Packet dates are explicitly labeled **Uploaded**.
- Immutable storage keys use the order ID and SHA-256 of the submitted bytes. Retried storage writes are reused only after checking the bytes. A per-order unique constraint prevents duplicate rows without resetting notes or selections.
- Removing a photo hides its row and blocks image retrieval; the stored bytes are retained. Explicitly uploading the same file again restores that row and its note. Photos are not automatically deleted from storage.
- The print button waits for pictures to decode and reports a failure instead of printing missing images. Browser print settings control paper size and the final PDF destination.

## Validation

The photo tests cover the real migration, order lifecycle retention, retry deduplication, photo removal/restoration, cross-order access, manager authorization, upload signature/full-decode validation, byte preservation, private storage failures, bounded retrieval, metadata validation, and selected-only printing with escaped captions. UI verification uses disposable local fixture data; no customer messages or QuickBooks writes are required.

The initial implementation passed all 103 photo/estimate/pricing/invoice-related tests and the production build. Existing unrelated catalog tests and six baseline `OrderDetail` lint errors remain. The user-facing workflow was subsequently simplified to the single Add photos button. This feature has not yet been migrated or deployed to production, and private Blob integration still needs the release smoke test above.

The simplified UI was checked at 390px using the actual estimate editor: one Add photos button when empty, immediate multi-photo attachment, compact thumbnails, and one-tap removal. All 33 photo tests pass.
