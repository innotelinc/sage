import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { Appraisal, AppraisalSummary, AppState } from '../../shared/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public resetsAt?: number,
  ) {
    super(message)
  }
}

export async function readError(response: Response): Promise<ApiError> {
  let message = response.statusText || 'Request failed.'
  let code: string | undefined
  let resetsAt: number | undefined
  try {
    const body = (await response.json()) as { error?: string; message?: string; resetsAt?: number }
    message = body.message ?? body.error ?? message
    code = body.error
    resetsAt = body.resetsAt
  } catch {
    /* no body */
  }
  return new ApiError(response.status, message, code, resetsAt)
}

/**
 * Where the API lives. On the web the Worker serves this bundle, so a relative
 * path is correct. A native build is served from `capacitor://localhost` and has
 * to be told the deployment's origin at build time, through VITE_API_BASE_URL.
 */
const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '')

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const response = await fetch(`${API_BASE}/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      accept: 'application/json',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  if (!response.ok) throw await readError(response)
  return (await response.json()) as T
}

export type AppraisalPage = { appraisal: Appraisal }

export const useAppState = () =>
  useQuery({
    queryKey: ['state'],
    queryFn: () => api<AppState>('/state'),
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    // Until a key is configured, keep checking so the app unlocks on its own
    // once one is saved in the admin panel or set in the environment.
    refetchInterval: (query) => (query.state.data && !query.state.data.capabilities.vision ? 8_000 : false),
  })

export function useSaveGatewayKey() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (key: string) => api<{ ok: true }>('/admin/key', { method: 'POST', json: { key } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['state'] }),
  })
}

export function useClearGatewayKey() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api<{ ok: true }>('/admin/key', { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['state'] }),
  })
}

export function useSetRequireKey() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (requireKey: boolean) => api<{ ok: true }>('/admin/require-key', { method: 'POST', json: { requireKey } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['state'] }),
  })
}

export const useAppraisals = () =>
  useQuery({ queryKey: ['appraisals'], queryFn: () => api<{ items: AppraisalSummary[] }>('/appraisals') })

export const useAppraisal = (id: string | undefined) =>
  useQuery({
    queryKey: ['appraisal', id],
    queryFn: () => api<AppraisalPage>(`/appraisals/${id}`),
    enabled: Boolean(id),
    staleTime: 60_000,
    // A missing appraisal is an answer, not a hiccup.
    retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500),
  })

export function useCreateAppraisal() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { image: string; thumb: string; note: string }) =>
      api<AppraisalPage>('/appraisals', { method: 'POST', json: input }),
    onSuccess: ({ appraisal }) => {
      client.setQueryData<AppraisalPage>(['appraisal', appraisal.id], { appraisal })
      void client.invalidateQueries({ queryKey: ['appraisals'] })
      void client.invalidateQueries({ queryKey: ['state'] })
    },
  })
}

export function useDeleteAppraisal() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api(`/appraisals/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      client.setQueryData<{ items: AppraisalSummary[] }>(['appraisals'], (old) => old && { items: old.items.filter((item) => item.id !== id) })
      client.removeQueries({ queryKey: ['appraisal', id] })
      void client.invalidateQueries({ queryKey: ['state'] })
    },
  })
}

export function useDeleteAllAppraisals() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api('/appraisals', { method: 'DELETE' }),
    onSuccess: () => {
      client.setQueryData(['appraisals'], { items: [] })
      client.removeQueries({ queryKey: ['appraisal'] })
      void client.invalidateQueries({ queryKey: ['state'] })
    },
  })
}
