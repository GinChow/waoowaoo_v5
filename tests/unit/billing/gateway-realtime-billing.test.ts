import { describe, expect, it } from 'vitest'
import { resolveCompletedSettlement } from '@/lib/codex-model-gateway/realtime-billing'
import {
  buildLlmUsageFactId,
  priceCatalogLlmUsage,
  priceReportedOpenRouterUsage,
} from '@/lib/billing/llm-usage'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'

ensureAiCatalogsRegistered()

// Oracle: the billing contract. OpenRouter is settled on the USD it reports per
// generation; every other Responses provider omits a cost field, so the
// production pricing catalog is canonical. A usage fact id must never collide
// across providers or change for OpenRouter's already-settled ledger rows.
function completed(usage: Record<string, unknown>) {
  return {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
        ...usage,
      },
    },
  }
}

describe('Codex gateway realtime settlement', () => {
  it('prices OpenRouter from its reported cost and keys the fact by generation', () => {
    const settlement = resolveCompletedSettlement(completed({ cost: 0.0123 }), {
      providerKey: 'openrouter', modelKey: 'openrouter::openai/gpt-5.6-luna', headerGenerationId: null,
    })
    expect(settlement).toMatchObject({
      pricingSource: 'openrouter_reported_cost',
      exactRetailCredits: priceReportedOpenRouterUsage(0.0123),
      usageId: buildLlmUsageFactId('openrouter-generation', ['resp_1']),
    })
  })

  it('prices every other provider from the catalog and scopes the fact by provider', () => {
    const settlement = resolveCompletedSettlement(completed({}), {
      providerKey: 'openlux', modelKey: 'openlux::gpt-5.6-luna', headerGenerationId: null,
    })
    expect(settlement).toMatchObject({
      pricingSource: 'catalog_usage',
      usageId: buildLlmUsageFactId('gateway-generation', ['openlux', 'resp_1']),
      usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 100 },
    })
    expect(settlement!.exactRetailCredits).toBe(priceCatalogLlmUsage(settlement!.usage))
    expect(settlement!.exactRetailCredits).toBeGreaterThan(0)
  })

  it('refuses an OpenRouter payload without reported cost instead of guessing', () => {
    expect(resolveCompletedSettlement(completed({}), {
      providerKey: 'openrouter', modelKey: 'openrouter::openai/gpt-5.6-luna', headerGenerationId: null,
    })).toBeNull()
  })
})
