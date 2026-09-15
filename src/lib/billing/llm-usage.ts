import { createHash } from 'node:crypto'
import { z } from 'zod'
import { usdToCredits } from '@/lib/ai-registry/pricing-currency'
import { retailCreditsFromCostCny } from '@/lib/ai-registry/pricing-retail'
import { calcTextToolCalls, calcTextWithCache } from './cost'

export const llmUsageFactSchema = z
  .object({
    phase: z.enum(['agent_model', 'context_compaction', 'web_search']),
    modelKey: z.string().trim().min(1).max(191),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    requestCount: z.number().int().nonnegative(),
    /** Server-side tool calls the provider bills per call on top of tokens. */
    toolCalls: z.number().int().nonnegative().default(0),
  })
  .strict()

export type LlmUsageFact = z.infer<typeof llmUsageFactSchema>

export function buildLlmUsageFactId(
  scope: 'openrouter-generation' | 'gateway-generation' | 'web-search',
  identityParts: readonly (string | number)[],
): string {
  const canonicalIdentity = identityParts
    .map((part) => {
      const value = String(part)
      return `${Buffer.byteLength(value, 'utf8')}:${value}`
    })
    .join('|')
  const digest = createHash('sha256').update(canonicalIdentity).digest('hex')
  return `llm-usage:v1:${scope}:${digest}`
}

/** Cloud OpenRouter returns its exact USD charge on every completed response. */
export function priceReportedOpenRouterUsage(costUsd: number): number {
  return retailCreditsFromCostCny(usdToCredits(costUsd), 'text')
}

/** Hosted OpenAI search has no response cost field, so its catalog is canonical. */
export function priceCatalogLlmUsage(usageValue: LlmUsageFact): number {
  const usage = llmUsageFactSchema.parse(usageValue)
  const tokenCost = calcTextWithCache(
    usage.modelKey,
    usage.inputTokens,
    usage.outputTokens,
    { cachedInputTokens: usage.cachedInputTokens },
  )
  return Number((tokenCost + calcTextToolCalls(usage.modelKey, usage.toolCalls)).toFixed(6))
}
