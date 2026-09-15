import { OPENROUTER_BUILTIN_PRICING_CATALOG_ENTRIES } from '@/lib/ai-providers/openrouter/models'
import { usdToCredits } from '@/lib/ai-registry/pricing-currency'
import { OPENLUX_ASPECT_RATIOS, OPENLUX_IMAGE_MODELS, OPENLUX_RESOLUTIONS, openLuxImageQualities } from './models'

// Temporary OpenRouter parity authorized by the product owner, not OpenLux
// provider costs. Base token rates checked at /api/v1/models on 2026-09-14;
// long-context/cache/tool premiums are not represented by this two-tier model.
const GEMINI_USD_PER_MILLION = [
  ['gemini-2.5-pro', 1.25, 10],
  ['gemini-2.5-flash', 0.3, 2.5],
  ['gemini-3-flash-preview', 0.5, 3],
] as const

// GPT-6 Astra has no project OpenRouter entry; base rate from the public
// catalog on 2026-09-15 (openai/gpt-6-astra: 10 / 50 USD per million).
const GPT_USD_PER_MILLION = [
  ['gpt-6-astra', 10, 50],
] as const

function tokenPrice(inputUsdPerMillion: number, outputUsdPerMillion: number) {
  return { mode: 'capability' as const, tiers: [
    { when: { tokenType: 'input' }, amount: usdToCredits(inputUsdPerMillion) },
    { when: { tokenType: 'output' }, amount: usdToCredits(outputUsdPerMillion) },
  ] }
}

function referencePrice(modelId: string) {
  const entry = OPENROUTER_BUILTIN_PRICING_CATALOG_ENTRIES.find((item) => item.modelId === modelId)
  if (!entry) throw new Error(`OPENLUX_REFERENCE_PRICE_MISSING:${modelId}`)
  return entry.cost
}

const IMAGE_PRICE_SIZE_BY_RATIO: Record<string, string> = {
  '1:1': '1024x1024', '4:3': '1024x768', '3:4': '1024x768',
  '3:2': '1024x1536', '2:3': '1024x1536', '9:16': '1024x1536', '16:9': '1920x1080',
}

function imagePrice(modelId: string) {
  const reference = referencePrice('openai/gpt-image-2')
  if (reference.mode !== 'capability') throw new Error('OPENLUX_REFERENCE_IMAGE_PRICE_INVALID')
  const tiers = reference.tiers as readonly { when: { imageSize: string; quality: string }; amount: number }[]
  // 2.5/-c share GPT Image 2 rates; auto/xhigh/max use high. OpenRouter's
  // image table is 1K-only: 2K/4K temporarily use the same aspect ratio tier.
  return { mode: 'capability' as const, tiers: [
    ...tiers,
    ...OPENLUX_RESOLUTIONS.flatMap((resolution) => OPENLUX_ASPECT_RATIOS.flatMap((aspectRatio) =>
      openLuxImageQualities(modelId).map((quality) => {
        const priceQuality = ['auto', 'xhigh', 'max'].includes(quality) ? 'high' : quality
        const tier = tiers.find((item) => item.when.imageSize === IMAGE_PRICE_SIZE_BY_RATIO[aspectRatio] && item.when.quality === priceQuality)
        if (!tier) throw new Error('OPENLUX_REFERENCE_IMAGE_TIER_MISSING')
        return { when: { resolution, aspectRatio, quality }, amount: tier.amount }
      }))),
  ] }
}

export const OPENLUX_PRICING = [
  ...[...GEMINI_USD_PER_MILLION, ...GPT_USD_PER_MILLION].map(([modelId, input, output]) => ({
    provider: 'openlux', modelId, apiType: 'text' as const, cost: tokenPrice(input, output),
  })),
  { provider: 'openlux', modelId: 'gemini-3.8-flash', apiType: 'text' as const, cost: referencePrice('google/gemini-3.8-flash') },
  // 3 Pro Preview is absent from the current catalog; use the retained Pro tier.
  { provider: 'openlux', modelId: 'gemini-3-pro-preview', apiType: 'text' as const, cost: referencePrice('google/gemini-3.1-pro-preview') },
  ...(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] as const).map((modelId) => ({
    provider: 'openlux', modelId, apiType: 'text' as const, cost: referencePrice(`openai/${modelId}`),
  })),
  ...OPENLUX_IMAGE_MODELS.map(([modelId]) => ({ provider: 'openlux', modelId, apiType: 'image' as const, cost: imagePrice(modelId) })),
]
