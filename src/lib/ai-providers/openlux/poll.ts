import { EXTERNAL_OPERATION } from '@/lib/external-operation/registry'
import { fetchProviderWithRetry, readProviderJsonResponse } from '@/lib/ai-providers/failure'
import { createProviderAsyncTaskFailure, type ProviderAsyncTaskStatus } from '@/lib/ai-providers/shared/async-task-status'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import { AppError } from '@/lib/errors/app-error'
import { describeUnknownError } from '@/lib/errors/normalize'
import { openLuxVideoTasksUrl } from './video'

type OpenLuxVideoTaskPayload = {
  status?: unknown
  content?: { video_url?: unknown } | Array<{ video_url?: { url?: unknown } }>
  error?: { code?: unknown; message?: unknown }
  usage?: { total_tokens?: unknown }
}

function readVideoUrl(content: OpenLuxVideoTaskPayload['content']): string | undefined {
  if (Array.isArray(content)) {
    for (const item of content) {
      const url = item?.video_url?.url
      if (typeof url === 'string' && url.trim()) return url.trim()
    }
    return undefined
  }
  const url = content?.video_url
  return typeof url === 'string' && url.trim() ? url.trim() : undefined
}

// Live statuses (2026-09-16): pending -> running -> succeeded; Ark also
// documents queued, failed and expired. Anything else is surfaced, not guessed.
export async function queryOpenLuxVideoStatus(
  taskId: string,
  input: { apiKey: string; baseUrl?: string },
): Promise<ProviderAsyncTaskStatus> {
  if (!input.apiKey) throw new AppError('PROVIDER_AUTH_INVALID', undefined, { provider: 'openlux' })
  const response = await fetchProviderWithRetry({
    url: openLuxVideoTasksUrl(input.baseUrl, taskId),
    provider: 'openlux',
    phase: 'poll',
    options: {
      operation: EXTERNAL_OPERATION.PROVIDER_POLL,
      method: 'GET',
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: 'application/json' },
      scope: 'openlux:video:query',
      fetchFn: fetchWithProviderProxy,
    },
  })
  const payload = await readProviderJsonResponse<OpenLuxVideoTaskPayload>({ response, provider: 'openlux', phase: 'poll' })
  const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : ''
  const actualVideoTokens = typeof payload.usage?.total_tokens === 'number' ? payload.usage.total_tokens : undefined

  if (status === 'succeeded') {
    const videoUrl = readVideoUrl(payload.content)
    if (videoUrl) return { status: 'completed', videoUrl, ...(actualVideoTokens !== undefined ? { actualVideoTokens } : {}) }
    return {
      status: 'failed',
      failure: createProviderAsyncTaskFailure({ provider: 'openlux', code: 'EMPTY_RESPONSE', message: 'No video URL in response', cause: payload }),
    }
  }
  if (status === 'failed' || status === 'expired' || status === 'cancelled' || status === 'canceled') {
    const message = typeof payload.error?.message === 'string' ? payload.error.message
      : payload.error ? describeUnknownError(payload.error) : `OpenLux task ${status}`
    return {
      status: 'failed',
      failure: createProviderAsyncTaskFailure({
        provider: 'openlux', code: 'GENERATION_FAILED', message, cause: payload.error ?? payload,
        details: { providerStatus: status, ...(typeof payload.error?.code === 'string' ? { providerCode: payload.error.code } : {}) },
      }),
    }
  }
  if (status === 'pending' || status === 'queued' || status === 'running') return { status: 'pending' }
  throw new Error(`OPENLUX_VIDEO_STATUS_UNKNOWN:${String(payload.status)}`)
}
