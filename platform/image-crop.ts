export interface BoundingBox {
  left: number    // 0.0–1.0 proportion of image width
  top: number     // 0.0–1.0 proportion of image height
  right: number   // 0.0–1.0 proportion of image width
  bottom: number  // 0.0–1.0 proportion of image height
}

export const FULL_IMAGE_BOX: BoundingBox = { left: 0, top: 0, right: 1, bottom: 1 }

const MIN_BOX_DIM = 0.05   // box must span at least 5% of each image dimension

/**
 * Returns true if the box is a real detection (not the full-image fallback,
 * not degenerate, not outside image bounds).
 */
export function isValidBox(box: BoundingBox): boolean {
  const w = box.right  - box.left
  const h = box.bottom - box.top
  const isFullImage =
    box.left <= 0.01 && box.top <= 0.01 && box.right >= 0.99 && box.bottom >= 0.99
  return (
    !isFullImage &&
    box.left >= 0 && box.top >= 0 &&
    box.right <= 1 && box.bottom <= 1 &&
    w >= MIN_BOX_DIM && h >= MIN_BOX_DIM
  )
}

/**
 * Expand a bounding box by `factor` on each side, clamped to [0, 1].
 * factor = 0.30 expands each edge by 30% of the box's own width/height.
 */
export function padBox(box: BoundingBox, factor = 0.30): BoundingBox {
  const w = box.right  - box.left
  const h = box.bottom - box.top
  const px = w * factor
  const py = h * factor
  return {
    left:   Math.max(0, box.left   - px),
    top:    Math.max(0, box.top    - py),
    right:  Math.min(1, box.right  + px),
    bottom: Math.min(1, box.bottom + py),
  }
}

/**
 * Crop a base64-encoded image to the given proportional bounding box.
 * Falls back to returning the original image if Sharp is unavailable.
 */
export async function cropToBase64(
  imageBase64: string,
  box: BoundingBox
): Promise<{ base64: string; mimeType: 'image/jpeg' }> {
  const isFullImage = box.left <= 0 && box.top <= 0 && box.right >= 1 && box.bottom >= 1
  if (isFullImage) return { base64: imageBase64, mimeType: 'image/jpeg' }

  try {
    const sharp = (await import('sharp')).default
    const buffer = Buffer.from(imageBase64, 'base64')
    const image  = sharp(buffer)
    const { width = 800, height = 600 } = await image.metadata()

    const l = Math.max(0, Math.floor(box.left   * width))
    const t = Math.max(0, Math.floor(box.top    * height))
    const r = Math.min(width,  Math.ceil(box.right  * width))
    const b = Math.min(height, Math.ceil(box.bottom * height))

    const cropped = await image
      .extract({ left: l, top: t, width: Math.max(1, r - l), height: Math.max(1, b - t) })
      .jpeg({ quality: 95 })
      .toBuffer()

    return { base64: cropped.toString('base64'), mimeType: 'image/jpeg' }
  } catch {
    return { base64: imageBase64, mimeType: 'image/jpeg' }
  }
}

/**
 * Draw bounding-box rectangles onto an image for debugging.
 * - rawBox:    dashed yellow  — what the model detected
 * - paddedBox: solid red      — the padded crop region
 *
 * Returns null if Sharp / SVG compositing fails.
 */
export async function drawBoxOverlay(
  imageBase64: string,
  rawBox: BoundingBox | null,
  paddedBox: BoundingBox | null
): Promise<string | null> {
  try {
    const sharp = (await import('sharp')).default
    const buffer = Buffer.from(imageBase64, 'base64')
    const { width: W = 800, height: H = 600 } = await sharp(buffer).metadata()

    const rects: string[] = []

    if (rawBox && isValidBox(rawBox)) {
      const x = Math.round(rawBox.left  * W)
      const y = Math.round(rawBox.top   * H)
      const w = Math.round((rawBox.right  - rawBox.left)  * W)
      const h = Math.round((rawBox.bottom - rawBox.top)   * H)
      rects.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
        `fill="none" stroke="yellow" stroke-width="3" stroke-dasharray="12 6" opacity="0.9"/>`
      )
    }

    if (paddedBox) {
      const x = Math.round(paddedBox.left  * W)
      const y = Math.round(paddedBox.top   * H)
      const w = Math.round((paddedBox.right  - paddedBox.left)  * W)
      const h = Math.round((paddedBox.bottom - paddedBox.top)   * H)
      rects.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
        `fill="rgba(255,0,0,0.06)" stroke="red" stroke-width="4" opacity="0.9"/>`
      )
    }

    if (rects.length === 0) return null

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects.join('')}</svg>`

    const result = await sharp(buffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 90 })
      .toBuffer()

    return result.toString('base64')
  } catch {
    return null
  }
}
