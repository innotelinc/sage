import { motion } from 'motion/react'
import { Camera, Coins, ImageUp, KeyRound, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { DAILY_APPRAISAL_LIMIT, VISION_MODEL_LABEL } from '../../shared/config'
import { CameraCapture } from '../components/CameraCapture'
import { Button, Input, Spinner, useToast } from '../components/ui'
import { ApiError, useAppState, useCreateAppraisal } from '../lib/api'
import { cx } from '../lib/cx'
import { preparePhoto, type PreparedPhoto } from '../lib/image'

const STAGES = ['Reading the date and lettering', 'Matching the design and mint mark', 'Weighing the grade against recent sales']

/**
 * Inside the iOS shell `getUserMedia` needs a platform permission prompt the
 * WebView does not manage for us, while a file input with `capture` opens the
 * system camera reliably. The modal camera stays for the browser.
 */
const isNativeShell = () =>
  Boolean((window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.())

export function Capture() {
  const navigate = useNavigate()
  const toast = useToast()
  const { data: state } = useAppState()
  const create = useCreateAppraisal()
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null)
  const [note, setNote] = useState('')
  const [reading, setReading] = useState(false)
  const [camera, setCamera] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accept = useCallback(
    async (file: Blob | null | undefined) => {
      if (!file) return
      setError(null)
      try {
        setPhoto(await preparePhoto(file))
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : 'That photo could not be read.')
      }
    },
    [],
  )

  // Paste a screenshot straight in.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) void accept(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [accept])

  const appraise = async () => {
    if (!photo || reading) return
    setError(null)
    setReading(true)
    try {
      const { appraisal } = await create.mutateAsync({ image: photo.image, thumb: photo.thumb, note: note.trim() })
      navigate(`/a/${appraisal.id}`)
    } catch (problem) {
      const message = problem instanceof ApiError ? problem.message : 'The appraisal failed. Try again.'
      setError(message)
      if (problem instanceof ApiError && problem.code === 'limit') toast(message, 'danger')
    } finally {
      setReading(false)
    }
  }

  const usage = state?.usage
  const limit = usage?.limit ?? DAILY_APPRAISAL_LIMIT
  const remaining = usage ? Math.max(0, usage.limit - usage.used) : limit
  const vision = state?.capabilities.vision ?? true
  const needsKey = (state?.capabilities.requireKey ?? true) && !vision

  return (
    <>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] px-5 py-8 md:px-8 md:py-12">
          <motion.header initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
            <p className="label-caps">Coin appraisal</p>
            <h1 className="font-display mt-2.5 text-[34px] leading-[1.04] tracking-[-0.02em] md:text-[44px]">
              Photograph a coin.
              <br />
              Learn what it&apos;s worth.
            </h1>
            <p className="mt-4 max-w-[52ch] text-[14.5px] leading-relaxed text-muted">
              One clear photo of the front is enough. Mintmark identifies the coin, grades what it can see, and gives a collector-market value range — with the reasons behind it.
            </p>
          </motion.header>

          {needsKey && (
            <div className="mt-6 flex flex-wrap items-center gap-3 rounded-card border border-line-strong bg-warning-soft/70 px-4 py-3">
              <KeyRound className="size-4 shrink-0 text-warning" />
              <p className="min-w-0 flex-1 text-[13px] leading-snug text-muted">
                Appraisals need a Mintmark gateway key. Paste one in <Link to="/admin" className="font-medium text-fg underline underline-offset-2">Admin</Link>, or set{' '}
                <code className="rounded-[5px] bg-surface/70 px-1 py-0.5 font-mono text-[12px] text-fg">MINTMARK_API_KEY</code> for the server. Keys are sold through Magnate.
              </p>
              <Link to="/admin" className="inline-flex h-8 items-center gap-1 rounded-tile bg-surface px-2.5 text-[13px] font-medium shadow-card transition-colors hover:bg-surface-2">
                Add a key
              </Link>
            </div>
          )}

          <div className="mt-7 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_312px]">
            <div>
              {photo ? (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="rounded-[26px] border border-line bg-surface p-4 shadow-card">
                  <div className="coin-photo relative overflow-hidden rounded-[18px] shadow-coin">
                    <img src={photo.image} alt="The coin you chose" className="mx-auto max-h-[400px] w-full object-contain" />
                    <Button
                      variant="secondary"
                      size="sm"
                      className="absolute right-3 top-3 shadow-pop"
                      onClick={() => fileInput.current?.click()}
                      disabled={reading}
                    >
                      <RotateCcw />
                      Replace
                    </Button>
                  </div>

                  <label htmlFor="note" className="label-caps mt-5 block">
                    Anything you already know <span className="normal-case tracking-normal">(optional)</span>
                  </label>
                  <Input
                    id="note"
                    className="mt-1.5"
                    maxLength={240}
                    value={note}
                    disabled={reading}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Found in a tin of old change, 1965 quarter…"
                  />

                  <Button variant="primary" className="mt-3 h-11 w-full text-[14.5px]" onClick={() => void appraise()} loading={reading} disabled={needsKey}>
                    {reading ? 'Reading the coin…' : 'Appraise this coin'}
                  </Button>
                  <p className="mt-2.5 text-center text-[12px] text-faint">
                    {needsKey ? 'Add a gateway key to start appraising' : `About 10 seconds · ${remaining} of ${limit} appraisals left today`}
                  </p>
                </motion.div>
              ) : (
                <div
                  onDragOver={(event) => {
                    event.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault()
                    setDragging(false)
                    void accept(event.dataTransfer.files[0])
                  }}
                  className={cx(
                    'flex min-h-[430px] flex-col items-center justify-center rounded-[26px] border border-dashed p-8 text-center transition-colors duration-200',
                    dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface/70',
                  )}
                >
                  <div className="grid size-16 place-items-center rounded-full border border-line-strong bg-surface shadow-card">
                    <Coins className="size-7 text-accent" />
                  </div>
                  <p className="font-display mt-5 text-[21px] tracking-[-0.01em]">Drop a photo here</p>
                  <p className="mt-1.5 text-[13px] text-muted">One coin, front side up · JPG, PNG or WebP</p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                    <Button variant="primary" onClick={() => (isNativeShell() ? cameraInput.current?.click() : setCamera(true))}>
                      <Camera />
                      Take a picture
                    </Button>
                    <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                      <ImageUp />
                      Choose a photo
                    </Button>
                  </div>
                  <p className="mt-4 text-[12px] text-faint">Or paste a screenshot with ⌘V / Ctrl+V</p>
                </div>
              )}

              {error && (
                <div className="mt-3 rounded-control border border-danger/20 bg-danger-soft px-4 py-3 text-[13px] leading-snug text-danger" role="alert">
                  {error}
                </div>
              )}
            </div>

            <aside className="space-y-4">
              {reading ? (
                <Working />
              ) : (
                <>
                  <section className="rounded-card border border-line bg-surface p-5 shadow-card">
                    <h2 className="label-caps">A photo that works</h2>
                    <ul className="mt-3 space-y-2.5 text-[13px] leading-snug text-muted">
                      <li>Fill the frame with the coin, front side up.</li>
                      <li>Daylight or a bright lamp — flash glare hides detail.</li>
                      <li>A plain surface; nothing covering the design.</li>
                      <li>Sharp focus, so the date and mint mark are legible.</li>
                    </ul>
                  </section>
                  <section className="rounded-card border border-line bg-surface-2/60 p-5">
                    <h2 className="label-caps">How it reads the coin</h2>
                    <ol className="mt-3 space-y-3 text-[13px] leading-snug text-muted">
                      {['Date, lettering and design are identified.', 'Wear is graded on the 1–70 Sheldon scale.', 'A collector-market range follows, in USD.'].map((line, index) => (
                        <li key={line} className="flex gap-3">
                          <span className="font-display text-[13px] text-accent">0{index + 1}</span>
                          <span>{line}</span>
                        </li>
                      ))}
                    </ol>
                    <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-faint">
                      Estimates by the {VISION_MODEL_LABEL} from one photograph. Not a professional grading or an offer.
                    </p>
                  </section>
                </>
              )}
            </aside>
          </div>
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          void accept(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          void accept(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <CameraCapture open={camera} onClose={() => setCamera(false)} onCapture={(blob) => void accept(blob)} />
    </>
  )
}

/** The wait, explained, so ten seconds of nothing is not a dead screen. */
function Working() {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setStage((value) => Math.min(STAGES.length - 1, value + 1)), 3200)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center gap-2.5">
        <Spinner />
        <p className="text-[13.5px] font-medium">Appraising</p>
      </div>
      <ul className="mt-4 space-y-3">
        {STAGES.map((label, index) => (
          <li key={label} className={cx('flex items-start gap-2.5 text-[13px] leading-snug transition-colors', index <= stage ? 'text-fg' : 'text-faint')}>
            <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', index <= stage ? 'bg-accent' : 'bg-line-strong')} />
            {label}
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-line pt-3 text-[11.5px] text-faint">Usually under fifteen seconds.</p>
    </section>
  )
}
