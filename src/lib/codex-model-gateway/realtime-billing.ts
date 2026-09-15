import { createScopedLogger } from '@/lib/logging/core'
import {
  buildLlmUsageFactId,
  priceCatalogLlmUsage,
  priceReportedOpenRouterUsage,
  type LlmUsageFact,
} from '@/lib/billing/llm-usage'
import type { RealtimeLlmSettlementInput } from '@/lib/edition/contracts/billing'
import { editionBilling } from '@/lib/edition/current/billing'

const MAX_SSE_EVENT_CHARS = 20 * 1024 * 1024

const billingLogger = createScopedLogger({ module: 'codex-gateway.billing' })

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0
}

function readGenerationId(response: Record<string, unknown>, headerGenerationId: string | null): string | null {
  const bodyId = typeof response.id === 'string' ? response.id.trim() : ''
  const value = bodyId || headerGenerationId?.trim() || ''
  return value && value.length <= 191 ? value : null
}

function readReportedCostUsd(usage: Record<string, unknown>): number | null {
  const costUsd = usage.cost
  return typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0
    ? costUsd
    : null
}

function parseCompletedUsage(
  payload: unknown,
  modelKey: string,
  headerGenerationId: string | null,
): { generationId: string; costUsd: number | null; usage: LlmUsageFact } | null {
  if (!isRecord(payload)) return null
  const response = payload.type === 'response.completed' && isRecord(payload.response)
    ? payload.response
    : payload.status === 'completed'
      ? payload
      : null
  if (!response || !isRecord(response.usage)) return null
  const generationId = readGenerationId(response, headerGenerationId)
  if (!generationId) return null
  const inputDetails = isRecord(response.usage.input_tokens_details)
    ? response.usage.input_tokens_details
    : null
  return {
    generationId,
    costUsd: readReportedCostUsd(response.usage),
    usage: {
      phase: 'agent_model',
      modelKey,
      inputTokens: readCount(response.usage.input_tokens),
      outputTokens: readCount(response.usage.output_tokens),
      cachedInputTokens: readCount(inputDetails?.cached_tokens),
      cacheWriteTokens: readCount(inputDetails?.cache_write_tokens),
      requestCount: 1,
      toolCalls: 0,
    },
  }
}

type SettlementContext = {
  readonly providerKey: string
  readonly modelKey: string
  readonly headerGenerationId: string | null
}

export type CompletedSettlement = Pick<
  RealtimeLlmSettlementInput,
  'usageId' | 'usage' | 'exactRetailCredits' | 'pricingSource'
>

/**
 * OpenRouter reports the exact USD charge on every completed response and its
 * ledger rows are keyed by that generation alone; keep that identity stable.
 * Every other Responses provider omits a cost field, so the pricing catalog is
 * canonical and the fact id carries the provider to keep generations disjoint.
 */
export function resolveCompletedSettlement(
  payload: unknown,
  context: SettlementContext,
): CompletedSettlement | null {
  const completed = parseCompletedUsage(payload, context.modelKey, context.headerGenerationId)
  if (!completed) return null
  if (context.providerKey === 'openrouter') {
    if (completed.costUsd === null) return null
    return {
      usageId: buildLlmUsageFactId('openrouter-generation', [completed.generationId]),
      usage: completed.usage,
      exactRetailCredits: priceReportedOpenRouterUsage(completed.costUsd),
      pricingSource: 'openrouter_reported_cost',
    }
  }
  return {
    usageId: buildLlmUsageFactId('gateway-generation', [context.providerKey, completed.generationId]),
    usage: completed.usage,
    exactRetailCredits: priceCatalogLlmUsage(completed.usage),
    pricingSource: 'catalog_usage',
  }
}

async function settleCompletedPayload(input: {
  payload: unknown
  headerGenerationId: string | null
  userId: string
  projectId: string
  turnId: string
  providerKey: string
  modelKey: string
}): Promise<void> {
  let settlement: CompletedSettlement | null
  try {
    settlement = resolveCompletedSettlement(input.payload, input)
  } catch (error) {
    // Catalog pricing is guaranteed for every admitted model; a miss here is an
    // audit alert, never a failure injected into an already-delivered stream.
    settlement = null
    billingLogger.error({
      audit: true,
      action: 'alert.billing.llm_completed_usage_invalid',
      message: 'completed Provider usage could not be priced',
      userId: input.userId,
      projectId: input.projectId,
      details: { turnId: input.turnId, providerKey: input.providerKey, modelKey: input.modelKey },
      error,
    })
    return
  }
  if (!settlement) {
    billingLogger.error({
      audit: true,
      action: 'alert.billing.llm_completed_usage_invalid',
      message: 'completed Provider response did not contain billable usage',
      userId: input.userId,
      projectId: input.projectId,
      details: { turnId: input.turnId, providerKey: input.providerKey, modelKey: input.modelKey },
    })
    return
  }
  const { usageId } = settlement
  try {
    const result = await editionBilling.settleRealtimeLlmUsage({
      ...settlement,
      projectId: input.projectId,
      userId: input.userId,
      action: 'assistant.run',
      metadata: { turnId: input.turnId },
    })
    if (result.uncoveredMicrocredits > BigInt(0)) {
      billingLogger.error({
        audit: true,
        action: 'alert.billing.llm_realtime_uncovered',
        message: 'realtime LLM usage exceeded the remaining whole-credit balance',
        userId: input.userId,
        projectId: input.projectId,
        details: {
          turnId: input.turnId,
          modelKey: input.modelKey,
          usageId,
          uncoveredMicrocredits: result.uncoveredMicrocredits.toString(),
        },
      })
    }
  } catch (error) {
    // The completed model result is already owed to the user. A ledger outage
    // is an audit alert, not a fake model failure that would trigger a retry.
    billingLogger.error({
      audit: true,
      action: 'alert.billing.llm_realtime_settlement_failed',
      message: 'completed Provider usage could not be settled',
      userId: input.userId,
      projectId: input.projectId,
      details: { turnId: input.turnId, modelKey: input.modelKey, usageId },
      error,
    })
  }
}

function readSseData(block: string): unknown {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  try {
    return JSON.parse(data) as unknown
  } catch {
    return null
  }
}

function wrapEventStream(input: {
  response: Response
  headerGenerationId: string | null
  userId: string
  projectId: string
  turnId: string
  providerKey: string
  modelKey: string
}): Response {
  if (!input.response.body) return input.response
  const decoder = new TextDecoder()
  let buffer = ''
  let parsingDisabled = false
  let completedObserved = false
  const settlements: Promise<void>[] = []

  const consumePayload = (payload: unknown) => {
    if (!isRecord(payload) || payload.type !== 'response.completed') return
    completedObserved = true
    settlements.push(settleCompletedPayload({
      payload,
      headerGenerationId: input.headerGenerationId,
      userId: input.userId,
      projectId: input.projectId,
      turnId: input.turnId,
      providerKey: input.providerKey,
      modelKey: input.modelKey,
    }))
  }

  const consumeBlocks = () => {
    while (!parsingDisabled) {
      const delimiter = /\r?\n\r?\n/u.exec(buffer)
      if (!delimiter || delimiter.index === undefined) break
      const block = buffer.slice(0, delimiter.index)
      buffer = buffer.slice(delimiter.index + delimiter[0].length)
      consumePayload(readSseData(block))
    }
    if (buffer.length > MAX_SSE_EVENT_CHARS) {
      parsingDisabled = true
      buffer = ''
      billingLogger.error({
        audit: true,
        action: 'alert.billing.llm_stream_usage_too_large',
        message: 'Provider SSE event exceeded the billing parser bound',
        userId: input.userId,
        projectId: input.projectId,
        details: { turnId: input.turnId, modelKey: input.modelKey },
      })
    }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (parsingDisabled) return
      buffer += decoder.decode(chunk, { stream: true })
      consumeBlocks()
    },
    async flush() {
      if (!parsingDisabled) {
        buffer += decoder.decode()
        consumeBlocks()
        if (buffer.trim()) {
          consumePayload(readSseData(buffer))
          buffer = ''
        }
        if (!completedObserved) {
          billingLogger.error({
            audit: true,
            action: 'alert.billing.llm_stream_completed_usage_missing',
            message: 'Provider stream ended without a completed usage event',
            userId: input.userId,
            projectId: input.projectId,
            details: { turnId: input.turnId, modelKey: input.modelKey },
          })
        }
      }
      await Promise.all(settlements)
    },
  })
  return new Response(input.response.body.pipeThrough(transform), {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: input.response.headers,
  })
}

export async function attachCodexRealtimeBilling(input: {
  response: Response
  headerGenerationId: string | null
  userId: string
  projectId: string
  turnId: string
  providerKey: string
  modelKey: string
}): Promise<Response> {
  const contentType = input.response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('text/event-stream')) return wrapEventStream(input)
  try {
    const payload: unknown = await input.response.clone().json()
    await settleCompletedPayload({ ...input, payload })
  } catch (error) {
    billingLogger.error({
      audit: true,
      action: 'alert.billing.llm_response_usage_unreadable',
      message: 'Provider response usage could not be read',
      userId: input.userId,
      projectId: input.projectId,
      details: { turnId: input.turnId, modelKey: input.modelKey },
      error,
    })
  }
  return input.response
}
