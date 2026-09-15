import type { AiOptionSchema } from '@/lib/ai-registry/types'
import {
  buildMediaOptionSchema,
  enumValidator,
  stringArrayValidator,
  type MediaModality,
} from '@/lib/ai-providers/shared/option-schema'
import {
  buildGptImage2OptionSchema,
} from '@/lib/ai-providers/shared/gpt-image-2'
import { usdToCredits } from '@/lib/ai-registry/pricing-currency'

export const YUNWU_GPT_IMAGE_2_MODEL_ID = 'gpt-image-2'
export const YUNWU_GPT_IMAGE_2_ALL_MODEL_ID = 'gpt-image-2-all'

export const YUNWU_GPT_IMAGE_2_ASPECT_RATIOS = [
  '1:1',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '16:9',
  '9:16',
] as const

export const YUNWU_GPT_IMAGE_2_ALL_ASPECT_RATIOS = ['1:1', '3:2', '2:3'] as const

function yunwuOpenRouterParityGptImage2Pricing() {
  const rows = [
    ['1024x768', { low: 0.005, medium: 0.037, high: 0.145 }],
    ['1024x1024', { low: 0.006, medium: 0.053, high: 0.211 }],
    ['1024x1536', { low: 0.005, medium: 0.042, high: 0.165 }],
    ['1920x1080', { low: 0.005, medium: 0.040, high: 0.158 }],
  ] as const
  return {
    mode: 'capability' as const,
    tiers: rows.flatMap(([imageSize, prices]) => [
      { when: { imageSize, quality: 'low' }, amount: usdToCredits(prices.low) },
      { when: { imageSize, quality: 'medium' }, amount: usdToCredits(prices.medium) },
      { when: { imageSize, quality: 'high' }, amount: usdToCredits(prices.high) },
    ]),
  }
}

export const YUNWU_BUILTIN_CAPABILITY_CATALOG_ENTRIES = [
  {
    modelType: 'image',
    provider: 'yunwu',
    modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
    capabilities: {
      image: {
        resolutionOptions: ['1K'],
        qualityOptions: ['low', 'medium', 'high'],
        maxReferenceImages: 16,
      },
    },
  },
  {
    modelType: 'image',
    provider: 'yunwu',
    modelId: YUNWU_GPT_IMAGE_2_ALL_MODEL_ID,
    capabilities: {
      image: {
        resolutionOptions: ['1K'],
        maxReferenceImages: 5,
      },
    },
  },
] as const

// Temporary product decision: Yunwu is billed with the exact OpenRouter GPT
// Image 2 table until Yunwu-specific provider costs are supplied.
export const YUNWU_BUILTIN_PRICING_CATALOG_ENTRIES = [
  {
    apiType: 'image',
    provider: 'yunwu',
    modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
    cost: yunwuOpenRouterParityGptImage2Pricing(),
  },
  {
    apiType: 'image',
    provider: 'yunwu',
    modelId: YUNWU_GPT_IMAGE_2_ALL_MODEL_ID,
    cost: yunwuOpenRouterParityGptImage2Pricing(),
  },
] as const

export const YUNWU_API_CONFIG_CATALOG_MODELS = [
  {
    modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
    name: 'GPT Image 2',
    type: 'image',
    provider: 'yunwu',
  },
  {
    modelId: YUNWU_GPT_IMAGE_2_ALL_MODEL_ID,
    name: 'GPT Image 2 All',
    type: 'image',
    provider: 'yunwu',
  },
] as const

const GPT_IMAGE_2_ALL_SIZE_BY_ASPECT_RATIO = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
} as const

export function resolveYunwuOptionSchema(
  modality: MediaModality,
  modelId?: string,
): AiOptionSchema {
  if (modality !== 'image') {
    throw new Error(`YUNWU_OPTION_SCHEMA_UNSUPPORTED_MODALITY:${modality}`)
  }

  if (modelId === YUNWU_GPT_IMAGE_2_MODEL_ID) {
    return buildGptImage2OptionSchema({
      resolutionOptions: ['1K'],
      aspectRatioOptions: YUNWU_GPT_IMAGE_2_ASPECT_RATIOS,
      qualityOptions: ['low', 'medium', 'high'],
      defaultResolution: '1K',
      defaultQuality: 'high',
      defaultOutputFormat: 'png',
      maxReferenceImages: 16,
      excludedKeys: ['keepOriginalAspectRatio', 'responseFormat'],
    })
  }

  if (modelId === YUNWU_GPT_IMAGE_2_ALL_MODEL_ID) {
    return buildMediaOptionSchema('image', {
      excludedKeys: [
        'keepOriginalAspectRatio',
        'outputFormat',
        'quality',
        'responseFormat',
        'size',
      ],
      required: ['aspectRatio'],
      validators: {
        aspectRatio: enumValidator(YUNWU_GPT_IMAGE_2_ALL_ASPECT_RATIOS),
        resolution: enumValidator(['1K']),
        referenceImages: stringArrayValidator({ maxLength: 5 }),
      },
      normalize: (options) => {
        const aspectRatio = options.aspectRatio as keyof typeof GPT_IMAGE_2_ALL_SIZE_BY_ASPECT_RATIO
        return {
          ...options,
          resolution: options.resolution ?? '1K',
          quality: 'high',
          outputFormat: 'png',
          referenceImages: options.referenceImages ?? [],
          wireSize: GPT_IMAGE_2_ALL_SIZE_BY_ASPECT_RATIO[aspectRatio],
        }
      },
    })
  }

  throw new Error(`YUNWU_OPTION_SCHEMA_UNSUPPORTED_IMAGE_MODEL:${modelId || '<missing>'}`)
}
