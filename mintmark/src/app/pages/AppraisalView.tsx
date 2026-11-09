import { motion } from 'motion/react'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import type { Appraisal } from '../../shared/types'
import { Badge, Button, ConfirmDialog, Spinner, useToast } from '../components/ui'
import { useAppraisal, useDeleteAppraisal } from '../lib/api'
import { cx } from '../lib/cx'
import { dateLabel, moneyRange } from '../lib/format'

export function AppraisalView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const page = useAppraisal(id)
  const remove = useDeleteAppraisal()
  const [confirm, setConfirm] = useState(false)

  if (page.isLoading) {
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner />
      </div>
    )
  }
  if (page.error || !page.data) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        <div>
          <p className="text-[15px] font-medium">This appraisal is not here any more.</p>
          <button type="button" onClick={() => navigate('/')} className="mt-2 text-[13.5px] text-muted underline underline-offset-2 hover:text-fg">
            Appraise another coin
          </button>
        </div>
      </div>
    )
  }

  const appraisal = page.data.appraisal

  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1080px] px-5 pb-14 pt-4 md:px-8 md:pt-6">
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={() => navigate('/')} className="inline-flex h-9 items-center gap-1.5 rounded-control px-2 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg">
            <ArrowLeft className="size-4" />
            New appraisal
          </button>
          <Button variant="ghost" onClick={() => setConfirm(true)}>
            <Trash2 />
            Delete
          </Button>
        </div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }} className="mt-4 grid items-start gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <figure className="rounded-[22px] border border-line bg-surface p-3 shadow-card">
            <div className="coin-photo overflow-hidden rounded-[16px]">
              <img src={appraisal.image} alt={appraisal.name ? `Front of ${appraisal.name}` : 'The coin that was appraised'} className="mx-auto max-h-[400px] w-full object-contain" />
            </div>
            <figcaption className="flex items-center justify-between px-1.5 pb-1 pt-3 text-[11px] text-faint">
              <span className="label-caps">Obverse</span>
              <span>{dateLabel(appraisal.createdAt)}</span>
            </figcaption>
            {appraisal.note && <p className="px-1.5 pb-1 text-[12.5px] leading-snug text-muted">“{appraisal.note}”</p>}
          </figure>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="label-caps">Appraisal</p>
              <Confidence value={appraisal.confidence} identified={appraisal.identified} />
            </div>
            <h1 className="font-display mt-2 text-[30px] leading-[1.1] tracking-[-0.015em] md:text-[36px]">
              {appraisal.identified ? appraisal.name || 'Unidentified coin' : 'Not identified'}
            </h1>
            <p className="mt-2 text-[13.5px] text-muted">
              {[appraisal.country, appraisal.denomination, appraisal.year && `${appraisal.year}${appraisal.mintMark ? ` · ${appraisal.mintMark}` : ''}`, appraisal.variety]
                .filter(Boolean)
                .join(' · ') || 'The photo did not show enough to place this coin.'}
            </p>

            {appraisal.identified ? (
              <div className="relative mt-5 overflow-hidden rounded-card bg-fg px-6 py-5 text-[#f5eeda] shadow-card">
                <div className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full opacity-40" style={{ background: 'radial-gradient(circle, #7a5a20 0%, transparent 68%)' }} />
                <p className="label-caps relative text-[#b6a988]">Estimated collector value</p>
                <p className="font-display relative mt-1.5 text-[36px] leading-none tracking-[-0.01em] md:text-[42px]">
                  {moneyRange(appraisal.valueLow, appraisal.valueHigh, appraisal.currency)}
                </p>
                <div className="relative mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-[#c4b795]">
                  <span className="inline-flex h-5 items-center rounded-[6px] border border-[#4a4231] px-1.5 font-medium text-[#e4d8ba]">{appraisal.currency}</span>
                  <span>{appraisal.valueBasis || 'Dealer to retail at the grade below.'}</span>
                </div>
              </div>
            ) : (
              <div className="mt-5 rounded-card border border-line-strong bg-warning-soft/70 p-5">
                <p className="text-[14px] font-medium">We couldn&apos;t put a value on this one.</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                  {appraisal.imageQuality || 'The photo did not show enough of the design. Try again with the coin filling the frame, flat and evenly lit.'}
                </p>
              </div>
            )}

            {appraisal.summary && <p className="mt-5 text-[14.5px] leading-relaxed text-muted">{appraisal.summary}</p>}

            {appraisal.identified && (
              <section className="mt-6 rounded-card border border-line bg-surface p-5 shadow-card">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="label-caps">Condition</h2>
                  <p className="font-display text-[15px]">
                    {appraisal.grade > 0 ? `${appraisal.gradeLabel || 'Graded'} · ${appraisal.grade}` : 'Not graded'}
                  </p>
                </div>
                <GradeScale grade={appraisal.grade} />
                {appraisal.condition && <p className="mt-3 text-[13px] leading-snug text-muted">{appraisal.condition}</p>}
              </section>
            )}

            <Specs appraisal={appraisal} />

            <Lists appraisal={appraisal} />

            {appraisal.imageQuality && appraisal.identified && (
              <p className="mt-5 rounded-control bg-surface-2 px-4 py-3 text-[12.5px] leading-snug text-muted">
                <span className="font-medium text-fg">About the photo: </span>
                {appraisal.imageQuality}
              </p>
            )}

            <p className="mt-7 border-t border-line pt-4 text-[11.5px] leading-relaxed text-faint">
              An estimate from one photograph — not a professional grading, and not an offer to buy. Values move with the market and fall sharply for cleaning, damage or a fake. Photograph the reverse and the edge, and get a second opinion, before selling anything significant.
            </p>
          </div>
        </motion.div>
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this appraisal?"
        description="The photo and its result are removed for good."
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(appraisal.id, {
            onSuccess: () => navigate('/', { replace: true }),
            onError: () => {
              setConfirm(false)
              toast('Could not delete this appraisal', 'danger')
            },
          })
        }
      />
    </div>
  )
}

function Confidence({ value, identified }: { value: number; identified: boolean }) {
  const percent = Math.round(value * 100)
  if (!identified) return <Badge tone="warning">Low confidence</Badge>
  const tone = percent >= 75 ? 'success' : percent >= 45 ? 'warning' : 'neutral'
  return <Badge tone={tone}>{percent >= 75 ? 'High' : percent >= 45 ? 'Moderate' : 'Low'} confidence · {percent}%</Badge>
}

function GradeScale({ grade }: { grade: number }) {
  const pct = Math.min(100, Math.max(0, ((grade - 1) / 69) * 100))
  const marks = [
    { grade: 1, label: 'P' },
    { grade: 12, label: 'F' },
    { grade: 20, label: 'VF' },
    { grade: 40, label: 'XF' },
    { grade: 50, label: 'AU' },
    { grade: 60, label: 'MS' },
    { grade: 70, label: '70' },
  ]
  return (
    <div className="mt-4">
      <div className="relative h-2 rounded-full bg-surface-2">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent/30" style={{ width: `${grade > 0 ? pct : 0}%` }} />
        {grade > 0 && (
          <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface" style={{ left: `${pct}%` }} />
        )}
      </div>
      <div className="relative mt-2 h-3.5">
        {marks.map((mark) => (
          <span
            key={mark.label}
            className={cx('absolute top-0 -translate-x-1/2 text-[10px]', Math.abs(mark.grade - grade) < 4 ? 'font-semibold text-accent' : 'text-faint')}
            style={{ left: `${((mark.grade - 1) / 69) * 100}%` }}
          >
            {mark.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function Specs({ appraisal }: { appraisal: Appraisal }) {
  const rows: [string, string][] = [
    ['Country', appraisal.country],
    ['Denomination', appraisal.denomination],
    ['Year', appraisal.year],
    ['Mint mark', appraisal.mintMark || 'None visible'],
    ['Variety', appraisal.variety],
    ['Composition', appraisal.composition],
    ['Rarity', appraisal.rarity],
  ]
  const shown = rows.filter(([, value]) => Boolean(value))
  if (!shown.length) return null
  return (
    <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5">
      {shown.map(([label, value]) => (
        <div key={label}>
          <dt className="label-caps">{label}</dt>
          <dd className="mt-1 text-[13.5px] leading-snug">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Lists({ appraisal }: { appraisal: Appraisal }) {
  const sections = [
    { title: 'What drives the value', items: appraisal.drivers, tone: 'brass' as const },
    { title: 'Worth checking', items: appraisal.checks, tone: 'brass' as const },
    { title: 'Watch for', items: appraisal.redFlags, tone: 'warning' as const },
  ].filter((section) => section.items.length > 0)

  if (!sections.length) return null
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2">
      {sections.map((section) => (
        <section key={section.title} className={cx('rounded-card border border-line p-5', section.tone === 'warning' ? 'bg-warning-soft/50' : 'bg-surface shadow-card')}>
          <h2 className="label-caps">{section.title}</h2>
          <ul className="mt-3 space-y-2">
            {section.items.map((item) => (
              <li key={item} className="flex gap-2.5 text-[13px] leading-snug text-muted">
                <span className={cx('mt-[7px] size-1 shrink-0 rounded-full', section.tone === 'warning' ? 'bg-warning' : 'bg-accent')} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
