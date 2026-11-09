import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Database } from 'lucide-react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import { Shell } from './components/Shell'
import { Spinner, ToastProvider } from './components/ui'
import { useAppState } from './lib/api'
import { Admin } from './pages/Admin'
import { AppraisalView } from './pages/AppraisalView'
import { Capture } from './pages/Capture'
import { Settings } from './pages/Settings'

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } } })

/** Only shown when the Worker has no database to read or write. */
function SetupNeeded({ message }: { message: string }) {
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-card border border-line bg-surface shadow-card">
          <Database className="size-5 text-muted" />
        </div>
        <h1 className="mt-4 text-[20px] font-semibold tracking-tight">Almost there</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">{message}</p>
        <p className="mt-4 text-[13px] text-faint">In Freebuff, ask the agent to add D1 storage named DB, then deploy again.</p>
      </div>
    </div>
  )
}

function Gate() {
  const state = useAppState()
  if (state.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    )
  }
  if (state.error) return <SetupNeeded message={state.error.message} />
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Capture />} />
        <Route path="a/:id" element={<AppraisalView />} />
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}
