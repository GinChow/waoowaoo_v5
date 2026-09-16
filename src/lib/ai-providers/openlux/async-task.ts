import type { AsyncTaskProviderRegistration, ParsedAsyncExternalId } from '@/lib/ai-providers/async-task-types'
import { normalizeAsyncPollResult } from '@/lib/ai-providers/async-task-types'
import { queryOpenLuxVideoStatus } from './poll'

function parseOpenLuxExternalId(externalId: string): ParsedAsyncExternalId {
  const [, type, ...rest] = externalId.split(':')
  const requestId = rest.join(':')
  if (type !== 'VIDEO' || !requestId) {
    throw new Error(`无效 OPENLUX externalId: "${externalId}"，应为 OPENLUX:VIDEO:requestId`)
  }
  return { provider: 'OPENLUX', type, requestId }
}

export const openLuxAsyncTaskProvider: AsyncTaskProviderRegistration = {
  providerCode: 'OPENLUX',
  providerKey: 'openlux',
  canParseExternalId: (externalId) => externalId.startsWith('OPENLUX:'),
  parseExternalId: parseOpenLuxExternalId,
  formatExternalId: (input) => `OPENLUX:${input.type}:${input.requestId}`,
  poll: async ({ parsed, context }) => {
    const { apiKey, baseUrl } = await context.getProviderConfig(context.userId, 'openlux')
    const result = await queryOpenLuxVideoStatus(parsed.requestId, { apiKey, baseUrl })
    return normalizeAsyncPollResult({
      status: result.status,
      ...(result.status === 'failed' ? { failure: result.failure } : {}),
      videoUrl: result.videoUrl,
      resultUrl: result.videoUrl,
      ...(typeof result.actualVideoTokens === 'number' ? { actualVideoTokens: result.actualVideoTokens } : {}),
    })
  },
}
