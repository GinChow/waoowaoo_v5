import { EXTERNAL_OPERATION } from '@/lib/external-operation/registry'
import { fetchProviderWithRetry, readProviderJsonResponse } from '@/lib/ai-providers/failure'
import { createProviderAsyncTaskFailure, type ProviderAsyncTaskStatus } from '@/lib/ai-providers/shared/async-task-status'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import { AppError } from '@/lib/errors/app-error'
import { describeUnknownError } from '@/lib/errors/normalize'
import { resolveMetasoBaseUrl } from './config'
import { METASO_VIDEO_QUERY_PATH } from './video'

type MetasoVideoTask = {
  status?: unknown
  content?: { url?: unknown }
  error?: { code?: unknown; type?: unknown; message?: unknown }
  usage?: { total_tokens?: unknown }
}

// Official query envelope is { task: {...} }; the relay returns it unchanged.
export async function queryMetasoVideoStatus(
  taskId: string,
  input: { apiKey: string; baseUrl?: string },
): Promise<ProviderAsyncTaskStatus> {
  if (!input.apiKey) throw new AppError('PROVIDER_AUTH_INVALID', undefined, { provider: 'metaso' })
  const response = await fetchProviderWithRetry({
    url: `${resolveMetasoBaseUrl(input.baseUrl)}${METASO_VIDEO_QUERY_PATH}/${encodeURIComponent(taskId)}`,
    provider: 'metaso',
    phase: 'poll',
    options: {
      operation: EXTERNAL_OPERATION.PROVIDER_POLL,
      method: 'GET',
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: 'application/json' },
      scope: 'metaso:video:query',
      fetchFn: fetchWithProviderProxy,
    },
  })
  const payload = await readProviderJsonResponse<{ task?: MetasoVideoTask }>({ response, provider: 'metaso', phase: 'poll' })
  const task = payload.task
  if (!task || typeof task !== 'object') throw new Error('METASO_VIDEO_QUERY_TASK_MISSING')
  const status = typeof task.status === 'string' ? task.status.toLowerCase() : ''
  const actualVideoTokens = typeof task.usage?.total_tokens === 'number' ? task.usage.total_tokens : undefined

  if (status === 'succeeded') {
    const url = task.content?.url
    if (typeof url === 'string' && url.trim()) {
      return { status: 'completed', videoUrl: url.trim(), ...(actualVideoTokens !== undefined ? { actualVideoTokens } : {}) }
    }
    return {
      status: 'failed',
      failure: createProviderAsyncTaskFailure({ provider: 'metaso', code: 'EMPTY_RESPONSE', message: 'No video URL in response', cause: payload }),
    }
  }
  if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
    const message = typeof task.error?.message === 'string' ? task.error.message
      : task.error ? describeUnknownError(task.error) : `MiniMax task ${status}`
    const providerCode = typeof task.error?.code === 'string' ? task.error.code
      : typeof task.error?.type === 'string' ? task.error.type : undefined
    return {
      status: 'failed',
      failure: createProviderAsyncTaskFailure({
        provider: 'metaso', code: 'GENERATION_FAILED', message, cause: task.error ?? payload,
        details: { providerStatus: status, ...(providerCode ? { providerCode } : {}) },
      }),
    }
  }
  if (status === 'queued' || status === 'running' || status === 'preparing' || status === 'processing') return { status: 'pending' }
  throw new Error(`METASO_VIDEO_STATUS_UNKNOWN:${String(task.status)}`)
}
