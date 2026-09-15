import { buildGptImage2OptionSchema } from '@/lib/ai-providers/shared/gpt-image-2'
import { enumValidator } from '@/lib/ai-providers/shared/option-schema'
import { OPENROUTER_GPT_5_6_REASONING_EFFORT_OPTIONS } from '@/lib/ai-providers/openrouter/models'

export const OPENLUX_IMAGE_MODELS = [
  ['gpt-image-2.5-flare', 'GPT Image 2.5 Flare'],
  ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'],
  ['gpt-image-2.5-flare-c', 'GPT Image 2.5 Flare C'],
  ['gpt-image-2.5-sunburst-c', 'GPT Image 2.5 Sunburst C'],
  ['gpt-image-2', 'GPT Image 2'],
  ['gpt-image-2-c', 'GPT Image 2 C'],
] as const

export const OPENLUX_LLM_MODELS = [
  ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
  ['gemini-3-pro-preview', 'Gemini 3 Pro Preview'],
  ['gemini-3-flash-preview', 'Gemini 3 Flash Preview'],
] as const

// OpenAI-series models reach OpenLux through its OpenAI-compatible /v1/responses;
// the Gemini channels reject that protocol (verified 2026-09-15), so only these
// are Codex assistant candidates. GPT-6 Astra streams and calls tools but never
// returned a reasoning item on this gateway at any effort.
export const OPENLUX_GPT_MODELS = [
  ['gpt-5.6-luna', 'GPT-5.6 Luna'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra'],
  ['gpt-5.6-sol', 'GPT-5.6 Sol'],
  ['gpt-6-astra', 'GPT-6 Astra'],
] as const

export function isOpenLuxGptModel(modelId: string): boolean {
  return OPENLUX_GPT_MODELS.some(([id]) => id === modelId)
}

export const OPENLUX_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'] as const
export const OPENLUX_RESOLUTIONS = ['1K', '2K', '4K'] as const

export function openLuxImageQualities(modelId: string) {
  return modelId.startsWith('gpt-image-2.5-')
    ? ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
    : ['low', 'medium', 'high', 'auto']
}

export function resolveOpenLuxImageOptionSchema(modelId: string) {
  if (!OPENLUX_IMAGE_MODELS.some(([id]) => id === modelId)) {
    throw new Error(`OPENLUX_IMAGE_MODEL_UNSUPPORTED:${modelId}`)
  }
  return buildGptImage2OptionSchema({
    resolutionOptions: OPENLUX_RESOLUTIONS,
    aspectRatioOptions: OPENLUX_ASPECT_RATIOS,
    qualityOptions: openLuxImageQualities(modelId),
    defaultResolution: '1K', defaultQuality: 'high', defaultOutputFormat: 'png', maxReferenceImages: 16,
    allowedKeys: ['background', 'moderation'], excludedKeys: ['keepOriginalAspectRatio'],
    validators: {
      background: enumValidator(['auto', 'opaque', 'transparent']),
      moderation: enumValidator(['auto', 'low']),
      responseFormat: enumValidator(['url', 'b64_json']),
    },
    objectValidators: [
      (options) => options.background === 'transparent' && options.outputFormat === 'jpeg'
        ? { ok: false, reason: 'transparent_background_requires_png_or_webp' }
        : { ok: true },
      (options) => Array.isArray(options.referenceImages) && options.referenceImages.length > 0 && options.outputFormat === 'webp'
        ? { ok: false, reason: 'openlux_image_edits_require_png_or_jpeg' }
        : { ok: true },
    ],
  })
}

export const OPENLUX_API_CONFIG_MODELS = [
  ...OPENLUX_LLM_MODELS.map(([modelId, name]) => ({ provider: 'openlux', modelId, name, type: 'llm' as const })),
  ...OPENLUX_GPT_MODELS.map(([modelId, name]) => ({ provider: 'openlux', modelId, name, type: 'llm' as const })),
  ...OPENLUX_IMAGE_MODELS.map(([modelId, name]) => ({ provider: 'openlux', modelId, name, type: 'image' as const })),
]

export const OPENLUX_CAPABILITIES = [
  ...OPENLUX_LLM_MODELS.map(([modelId]) => ({ provider: 'openlux', modelId, modelType: 'llm' as const,
    capabilities: { llm: { protocol: 'google-generative-ai', publicReasoningMode: 'native',
      reasoningEffortOptions: ['low', 'high'], defaultReasoningEffort: 'high' } },
  })),
  ...OPENLUX_GPT_MODELS.map(([modelId]) => ({ provider: 'openlux', modelId, modelType: 'llm' as const,
    capabilities: { llm: { protocol: 'openai-responses', codexRuntimeWireApi: 'responses', publicReasoningMode: 'summary_auto',
      reasoningEffortOptions: [...OPENROUTER_GPT_5_6_REASONING_EFFORT_OPTIONS], defaultReasoningEffort: 'medium', contextWindow: 1_050_000 } },
  })),
  ...OPENLUX_IMAGE_MODELS.map(([modelId]) => ({ provider: 'openlux', modelId, modelType: 'image' as const,
    capabilities: { image: { resolutionOptions: OPENLUX_RESOLUTIONS, qualityOptions: openLuxImageQualities(modelId), maxReferenceImages: 16 } },
  })),
]
