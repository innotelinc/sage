import { Camera } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button, Dialog } from './ui'

/** Opens the device camera and hands back one JPEG frame. */
export function CameraCapture({ open, onClose, onCapture }: { open: boolean; onClose: () => void; onCapture: (blob: Blob) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setReady(false)
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot open a camera here. Choose a photo instead.')
      return
    }
    let stream: MediaStream | null = null
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false })
      .then((media) => {
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop())
          return
        }
        stream = media
        if (video.current) {
          video.current.srcObject = media
          void video.current.play().catch(() => undefined)
        }
        setReady(true)
      })
      .catch(() => {
        if (!cancelled) setError('No camera available. Choose a photo instead.')
      })
    return () => {
      cancelled = true
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [open])

  const shoot = () => {
    const element = video.current
    if (!element || !element.videoWidth) return
    const scale = Math.min(1, 1600 / Math.max(element.videoWidth, element.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(element.videoWidth * scale)
    canvas.height = Math.round(element.videoHeight * scale)
    canvas.getContext('2d')?.drawImage(element, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        onCapture(blob)
        onClose()
      },
      'image/jpeg',
      0.92,
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Take a picture"
      description="Fill the frame with the coin, front side up, in even light."
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={shoot} disabled={!ready}>
            <Camera />
            Capture
          </Button>
        </>
      }
    >
      <div className="overflow-hidden rounded-tile bg-fg">
        {error ? (
          <div className="grid aspect-[4/3] place-items-center px-6 text-center text-[13.5px] leading-relaxed text-[#ded4bd]">{error}</div>
        ) : (
          <video ref={video} playsInline muted autoPlay className="aspect-[4/3] w-full bg-fg object-contain" />
        )}
      </div>
    </Dialog>
  )
}
