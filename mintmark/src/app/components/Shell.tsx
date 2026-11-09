import { AnimatePresence, motion } from 'motion/react'
import { KeyRound, Menu as MenuIcon, Plus, Settings as SettingsIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'

import { BRAND } from '../../shared/config'
import type { AppraisalSummary } from '../../shared/types'
import { useAppraisals, useAppState } from '../lib/api'
import { cx } from '../lib/cx'
import { DAY_GROUPS, dayGroup, moneyRange } from '../lib/format'
import { Button } from './ui'

export function Logo({ className, size = 26 }: { className?: string; size?: number }) {
  return (
    <Link to="/" className={cx('inline-flex items-center gap-2.5 text-fg', className)}>
      <Mark size={size} />
      <span className="font-display text-[19px] tracking-[-0.01em]">{BRAND}</span>
    </Link>
  )
}

/** The brand mark: a coin with a milled edge. */
export function Mark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <span className={cx('grid shrink-0 place-items-center rounded-[9px] bg-fg', className)} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 64 64" width={size * 0.68} height={size * 0.68} fill="none" stroke="#efe6d1">
        <circle cx="32" cy="32" r="19" strokeWidth="3" />
        <circle cx="32" cy="32" r="11" strokeWidth="1.5" opacity=".55" />
        <path d="M32 5v6M32 53v6M5 32h6M53 32h6" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  )
}

export function Shell() {
  const [drawer, setDrawer] = useState(false)
  const location = useLocation()
  useEffect(() => setDrawer(false), [location.pathname])
  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-[276px] shrink-0 flex-col border-r border-line bg-bg md:flex">
        <Sidebar />
      </aside>
      <AnimatePresence>
        {drawer && (
          <motion.div
            key="drawer"
            className="fixed inset-0 z-40 bg-fg/30 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onMouseDown={() => setDrawer(false)}
          >
            <motion.aside
              className="absolute inset-y-0 left-0 flex w-[292px] flex-col bg-bg shadow-dialog"
              initial={{ x: -40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -40, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <Sidebar onClose={() => setDrawer(false)} />
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-line px-3 md:hidden">
          <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <MenuIcon />
          </Button>
          <Logo size={22} />
          <span className="flex-1" />
          <NavLink to="/settings" className="grid size-9 place-items-center rounded-control text-muted hover:bg-surface-2 hover:text-fg" aria-label="Settings">
            <SettingsIcon className="size-4" />
          </NavLink>
        </header>
        <Outlet />
      </div>
    </div>
  )
}

function Sidebar({ onClose }: { onClose?: () => void }) {
  const { data: state } = useAppState()
  const { data } = useAppraisals()
  const navigate = useNavigate()
  const location = useLocation()
  const items = data?.items ?? []
  const groups = DAY_GROUPS.map((group) => ({ group, items: items.filter((item) => dayGroup(item.createdAt) === group) })).filter((entry) => entry.items.length)

  return (
    <>
      <div className="flex h-16 items-center justify-between px-4">
        <Logo />
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close menu" onClick={onClose}>
            <X />
          </Button>
        )}
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={() => {
            onClose?.()
            navigate('/')
          }}
          className={cx(
            'flex h-10 w-full items-center gap-2 rounded-control border border-line-strong px-3 text-[13.5px] font-medium shadow-card transition-colors',
            location.pathname === '/' ? 'bg-fg text-white' : 'bg-surface text-fg hover:bg-surface-2',
          )}
        >
          <Plus className="size-4" />
          New appraisal
        </button>
      </div>

      <nav className="scrollbar-thin mt-4 flex-1 overflow-y-auto px-3 pb-3" aria-label="Collection">
        {groups.map(({ group, items: groupItems }) => (
          <section key={group} className="mb-4">
            <h2 className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-[0.1em] text-faint">{group}</h2>
            <ul className="space-y-0.5">
              {groupItems.map((item) => (
                <AppraisalRow key={item.id} item={item} />
              ))}
            </ul>
          </section>
        ))}
        {data && items.length === 0 && (
          <p className="px-2.5 pt-6 text-[12.5px] leading-relaxed text-faint">Your appraisals will appear here, with the value range and the photo you took.</p>
        )}
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-1">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cx('flex h-12 min-w-0 flex-1 items-center gap-3 rounded-control px-2 transition-colors', isActive ? 'bg-surface shadow-card' : 'hover:bg-surface')
            }
          >
            <SettingsIcon className="size-4 shrink-0 text-faint" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">Settings</span>
              <span className="block truncate text-[11.5px] text-faint">
                {state ? `${state.usage.used} of ${state.usage.limit} appraisals today` : ''}
              </span>
            </span>
          </NavLink>
          <NavLink
            to="/admin"
            aria-label="Admin"
            className={({ isActive }) =>
              cx('grid size-10 shrink-0 place-items-center rounded-control transition-colors', isActive ? 'bg-surface text-fg shadow-card' : 'text-muted hover:bg-surface hover:text-fg')
            }
          >
            <KeyRound className="size-4" />
          </NavLink>
        </div>
      </div>
    </>
  )
}

function AppraisalRow({ item }: { item: AppraisalSummary }) {
  return (
    <li>
      <NavLink
        to={`/a/${item.id}`}
        className={({ isActive }) =>
          cx('flex h-12 items-center gap-2.5 rounded-control px-2 transition-colors', isActive ? 'bg-surface shadow-card' : 'hover:bg-surface')
        }
      >
        {item.thumb ? (
          <img src={item.thumb} alt="" className="round size-8 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="round size-8 shrink-0 rounded-full bg-surface-2" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">{item.identified ? item.name || 'Coin' : 'Not identified'}</span>
          <span className="block truncate text-[11.5px] text-faint">
            {item.identified ? moneyRange(item.valueLow, item.valueHigh, item.currency, true) : item.subtitle || 'No value'}
          </span>
        </span>
      </NavLink>
    </li>
  )
}
