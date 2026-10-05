export const MAX_PHOTO_BYTES = 4 * 1024 * 1024
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024
export const MAX_CAPTION_LENGTH = 500

export interface OrderPhoto {
  id: string
  filename: string
  caption: string
  included: boolean
  resized: boolean
  createdAt: string
  imageUrl: string
  downloadUrl: string
}
