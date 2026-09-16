import { SEEDANCE_2_5_RETAIL_CREDITS_PER_SECOND } from '@/lib/ai-providers/shared/seedance-pricing'
import { CREDITS_PER_CNY } from '@/lib/billing/credits'
import { RETAIL_MARKUP_BY_API_TYPE } from '@/lib/ai-registry/pricing-retail'
import { METASO_VIDEO_MODELS, type MetasoVideoResolution } from './video-models'

// Placeholder authorized by the product owner (2026-09-16): no Metaso or
// MiniMax quote is recorded yet. Retail borrows the Seedance 2.5 product tier
// of the nearest resolution; cost is back-derived at the standard video markup
// so the margin fuse reflects the rate we actually charge. Replace both faces
// together once a real quote exists.
const RETAIL_CREDITS_PER_SECOND: Record<MetasoVideoResolution, number> = {
  '480P': SEEDANCE_2_5_RETAIL_CREDITS_PER_SECOND['480p'],
  '768P': SEEDANCE_2_5_RETAIL_CREDITS_PER_SECOND['720p'],
  '2K': SEEDANCE_2_5_RETAIL_CREDITS_PER_SECOND['1080p'],
}

function placeholderCostCny(retailCredits: number): number {
  return Number((retailCredits / (RETAIL_MARKUP_BY_API_TYPE.video * CREDITS_PER_CNY)).toFixed(6))
}

export const METASO_PRICING = METASO_VIDEO_MODELS.map((spec) => ({
  provider: 'metaso', modelId: spec.modelId, apiType: 'video' as const,
  cost: { mode: 'capability' as const, unit: 'per_second' as const,
    tiers: spec.resolutions.map((resolution) => ({ when: { resolution }, amount: placeholderCostCny(RETAIL_CREDITS_PER_SECOND[resolution]) })) },
  retail: { mode: 'capability' as const, unit: 'per_second' as const,
    tiers: spec.resolutions.map((resolution) => ({ when: { resolution }, amount: RETAIL_CREDITS_PER_SECOND[resolution] })) },
}))
