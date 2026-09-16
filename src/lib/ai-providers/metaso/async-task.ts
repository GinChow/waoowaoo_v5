import type { AsyncTaskProviderRegistration, ParsedAsyncExternalId } from '@/lib/ai-providers/async-task-types'
import { normalizeAsyncPollResult } from '@/lib/ai-providers/async-task-types'
import { queryMetasoVideoStatus } from './poll'

function parseMetasoExternalId(externalId: string): ParsedAsyncExternalId {
  const [, type, ...rest] = externalId.split(':')
  const requestId = rest.join(':')
  if (type !== 'VIDEO' || !requestId) {
    throw new Error(`无效 METASO externalId: "${externalId}"，应为 METASO:VIDEO:requestId`)
  }
  return { provider: 'METASO', type, requestId }
}

export const metasoAsyncTaskProvider: AsyncTaskProviderRegistration = {
  providerCode: 'METASO',
  providerKey: 'metaso',
  canParseExternalId: (externalId) => externalId.startsWith('METASO:'),
  parseExternalId: parseMetasoExternalId,
  formatExternalId: (input) => `METASO:${input.type}:${input.requestId}`,
  poll: async ({ parsed, context }) => {
    const { apiKey, baseUrl } = await context.getProviderConfig(context.userId, 'metaso')
    const result = await queryMetasoVideoStatus(parsed.requestId, { apiKey, baseUrl })
    return normalizeAsyncPollResult({
      status: result.status,
      ...(result.status === 'failed' ? { failure: result.failure } : {}),
      videoUrl: result.videoUrl,
      resultUrl: result.videoUrl,
      ...(typeof result.actualVideoTokens === 'number' ? { actualVideoTokens: result.actualVideoTokens } : {}),
    })
  },
}
