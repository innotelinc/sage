import { ArrowUpRight, KeyRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { GATEWAY_KEYS_URL } from '../../shared/config'
import { Badge, Button, Input, useToast } from '../components/ui'
import { ApiError, useAppState, useClearGatewayKey, useSaveGatewayKey, useSetRequireKey } from '../lib/api'
import { cx } from '../lib/cx'

const sourceLabel: Record<'stored' | 'env', string> = {
  stored: 'Stored in this app',
  env: 'From MINTMARK_API_KEY',
}

export function Admin() {
  const { data: state } = useAppState()
  const toast = useToast()
  const save = useSaveGatewayKey()
  const clear = useClearGatewayKey()
  const requirement = useSetRequireKey()
  const [draft, setDraft] = useState('')

  if (!state) return null
  const { gateway, capabilities } = state

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const key = draft.trim()
    if (!key) return
    save.mutate(key, {
      onSuccess: () => {
        setDraft('')
        toast('Key saved')
      },
      onError: (error) => toast(error instanceof ApiError ? error.message : 'Could not save that key', 'danger'),
    })
  }

  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[640px] px-5 py-8 md:px-6 md:py-10">
        <h1 className="font-display text-[26px] tracking-[-0.015em]">Admin</h1>
        <p className="mt-2 max-w-[46ch] text-[13px] leading-relaxed text-muted">
          This instance has no sign-in: anyone who opens it can appraise coins. Keep the gateway key here, on the server.
        </p>

        <section className="mt-8">
          <h2 className="label-caps">Gateway key</h2>
          <div className="mt-3 rounded-card border border-line bg-surface p-4 shadow-card">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-tile bg-surface-2">
                <KeyRound className="size-4 text-accent" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium">Mintmark gateway</p>
                <p className="mt-0.5 truncate text-[12px] text-faint">
                  {gateway.keySource && gateway.keyHint ? `${sourceLabel[gateway.keySource]} · ${gateway.keyHint}` : 'No key configured'}
                </p>
              </div>
              <Badge tone={capabilities.vision ? 'success' : 'warning'}>{capabilities.vision ? 'Connected' : 'Not set'}</Badge>
            </div>

            <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                name="key"
                autoComplete="off"
                spellCheck={false}
                placeholder={gateway.keySource === 'stored' ? 'Replace the stored key' : 'sk-…'}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="font-mono text-[12.5px]"
                aria-label="Mintmark gateway key"
              />
              <Button type="submit" variant="primary" className="sm:w-28" loading={save.isPending} disabled={!draft.trim()}>
                Save key
              </Button>
            </form>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-faint">
              <span className="flex-1">Checked against the gateway before it is stored. Never sent back to the browser.</span>
              {gateway.keySource === 'stored' && (
                <Button
                  size="sm"
                  variant="danger"
                  loading={clear.isPending}
                  onClick={() =>
                    clear.mutate(undefined, {
                      onSuccess: () => toast('Stored key removed'),
                      onError: () => toast('Could not remove the key', 'danger'),
                    })
                  }
                >
                  Remove key
                </Button>
              )}
              <a
                href={GATEWAY_KEYS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-tile px-2 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
              >
                Get a key
                <ArrowUpRight className="size-3.5" />
              </a>
            </div>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="label-caps">Access</h2>
          <div className="mt-3 flex items-start gap-4 rounded-card border border-line bg-surface p-4 shadow-card">
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium">Require a gateway key</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-faint">
                {capabilities.requireKey
                  ? 'Appraisals are blocked, with a setup notice, until a key is saved.'
                  : 'Off: the app lets anyone press Appraise. Without a key the gateway call fails with its own message.'}
              </p>
            </div>
            <Switch
              label="Require a gateway key"
              checked={capabilities.requireKey}
              disabled={requirement.isPending}
              onChange={(value) =>
                requirement.mutate(value, {
                  onSuccess: () => toast(value ? 'Appraisals now need a key' : 'Appraisals no longer need a key'),
                  onError: () => toast('Could not change that setting', 'danger'),
                })
              }
            />
          </div>
        </section>

        <section className="mt-8">
          <h2 className="label-caps">Model</h2>
          <dl className="mt-3 divide-y divide-line rounded-card border border-line bg-surface shadow-card">
            <div className="flex items-baseline gap-3 px-4 py-3">
              <dt className="w-20 shrink-0 text-[12.5px] text-faint">Model</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{gateway.model}</dd>
            </div>
            <div className="flex items-baseline gap-3 px-4 py-3">
              <dt className="w-20 shrink-0 text-[12.5px] text-faint">Gateway</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-muted">{gateway.baseUrl}</dd>
            </div>
          </dl>
          <p className="mt-2 text-[12px] leading-relaxed text-faint">
            Set <code className="rounded-[5px] bg-surface-2 px-1 py-0.5 font-mono text-[11.5px] text-fg">MINTMARK_MODEL</code> and{' '}
            <code className="rounded-[5px] bg-surface-2 px-1 py-0.5 font-mono text-[11.5px] text-fg">MINTMARK_BASE_URL</code> to change these.
          </p>
        </section>
      </div>
    </div>
  )
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        className={cx(
          'absolute top-1 size-4 rounded-full bg-white shadow-card transition-[left] duration-150',
          checked ? 'left-6' : 'left-1',
        )}
      />
    </button>
  )
}
