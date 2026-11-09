// A phone photo is 3-8 MB and the model does not need that. Everything is
// scaled here, before upload, so the request stays small and fast.

export const MAX_FILE_BYTES = 30 * 1024 * 1024
/** Well under the server's 2 MB limit, after re-encoding if needed. */
const TARGET_BYTES = 1_700_000

export type PreparedPhoto = { image: string; thumb: string; width: number; height: number }

type Decoded = { source: CanvasImageSource; width: number; height: number; cleanup: () => void }

async function decode(file: Blob): Promise<Decoded> {
  try {
    const bitmap = await createImageBitmap(file)
    return { source: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close() }
  } catch {
    // HEIC and a few exotic formats only decode through an <img>.
    const url = URL.createObjectURL(file)
    try {
      const image = new Image()
      image.decoding = 'async'
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('That image could not be read. Use a JPG, PNG or WebP photo.'))
        image.src = url
      })
      return { source: image, width: image.naturalWidth, height: image.naturalHeight, cleanup: () => URL.revokeObjectURL(url) }
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
  }
}

function render(decoded: Decoded, maxEdge: number, quality: number): string {
  const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(decoded.width * scale))
  canvas.height = Math.max(1, Math.round(decoded.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not process the image.')
  context.imageSmoothingQuality = 'high'
  context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

const sizeOf = (dataUrl: string) => Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)

export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is over 30 MB. Try a smaller photo.')
  const decoded = await decode(file)
  try {
    let image = render(decoded, 1280, 0.85)
    if (sizeOf(image) > TARGET_BYTES) image = render(decoded, 1280, 0.68)
    if (sizeOf(image) > TARGET_BYTES) image = render(decoded, 1024, 0.7)
    const thumb = render(decoded, 400, 0.72)
    return { image, thumb, width: decoded.width, height: decoded.height }
  } finally {
    decoded.cleanup()
  }
}
