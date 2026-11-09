import { ArrowRight, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { DAILY_APPRAISAL_LIMIT, VISION_MODEL_LABEL } from '../../shared/config'
import { Badge, Button, ConfirmDialog, useToast } from '../components/ui'
import { useAppState, useDeleteAllAppraisals } from '../lib/api'
import { untilLabel } from '../lib/format'

export function Settings() {
  const { data: state } = useAppState()
  const toast = useToast()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState(false)
  const clear = useDeleteAllAppraisals()
  if (!state) return null

  const { gateway, capabilities, usage } = state
  const keyDetail =
    gateway.keySource === 'stored'
      ? `Key stored in the app · ${gateway.keyHint ?? ''}`
      : gateway.keySource === 'env'
        ? `Key from MINTMARK_API_KEY · ${gateway.keyHint ?? ''}`
        : 'No key configured'

  const connections = [
    { label: `Vision model · ${VISION_MODEL_LABEL}`, ok: capabilities.vision, detail: keyDetail },
    { label: 'Database', ok: capabilities.database, detail: 'D1 via the DB binding' },
  ]

  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[640px] px-5 py-8 md:px-6 md:py-10">
        <h1 className="font-display text-[26px] tracking-[-0.015em]">Settings</h1>

        <section className="mt-8">
          <h2 className="label-caps">Usage</h2>
          <div className="mt-3 rounded-card border border-line bg-surface p-4 shadow-card">
            <div className="flex items-baseline justify-between">
              <p className="text-[15px] font-medium">
                {usage.used} of {usage.limit || DAILY_APPRAISAL_LIMIT} appraisals today
              </p>
              <p className="text-[12.5px] text-faint">Resets {untilLabel(usage.resetsAt)}</p>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-[3px] bg-surface-2">
              <div
                className="h-full rounded-[3px] bg-accent transition-[width] duration-500"
                style={{ width: `${Math.min(100, Math.round((usage.used / (usage.limit || DAILY_APPRAISAL_LIMIT)) * 100))}%` }}
              />
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-faint">Each appraisal sends one photo through the gateway and is billed to the Mintmark key's owner.</p>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="label-caps">Admin</h2>
          <Link
            to="/admin"
            className="mt-3 flex items-center gap-3 rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:bg-surface-2"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-tile bg-surface-2">
              <SlidersHorizontal className="size-4 text-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium">Gateway key and access</span>
              <span className="block truncate text-[12px] text-faint">{keyDetail}</span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-faint" />
          </Link>
        </section>

        <section className="mt-8">
          <h2 className="label-caps">Connections</h2>
          <ul className="mt-3 divide-y divide-line rounded-card border border-line bg-surface shadow-card">
            {connections.map((item) => (
              <li key={item.label} className="flex min-h-13 items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">{item.label}</span>
                  <span className="block truncate text-[12px] text-faint">{item.detail}</span>
                </span>
                <Badge tone={item.ok ? 'success' : 'neutral'}>{item.ok ? 'Connected' : 'Not set'}</Badge>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-8">
          <h2 className="label-caps">Data</h2>
          <div className="mt-3 flex items-center justify-between gap-4 rounded-card border border-line bg-surface p-4 shadow-card">
            <div>
              <p className="text-[13.5px] font-medium">Delete all appraisals</p>
              <p className="text-[12.5px] text-faint">Removes every saved coin, photo and result.</p>
            </div>
            <Button variant="danger" onClick={() => setConfirm(true)}>
              Delete
            </Button>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete all appraisals?"
        description="Every coin, photo and result is removed for good."
        confirmLabel="Delete everything"
        loading={clear.isPending}
        onConfirm={() =>
          clear.mutate(undefined, {
            onSuccess: () => {
              setConfirm(false)
              toast('All appraisals deleted')
              navigate('/')
            },
            onError: () => toast('Could not delete your appraisals', 'danger'),
          })
        }
      />
    </div>
  )
}
