import type { AiProviderAdapter } from '@/lib/ai-providers/runtime-types'
import { createAiProviderFailureAdapter } from '@/lib/ai-providers/failure'
import { describeMediaVariantBase } from '@/lib/ai-providers/shared/media-adapter'
import { executeYunwuImageGeneration } from './image'
import { resolveYunwuOptionSchema } from './models'

export const yunwuAdapter: AiProviderAdapter = {
  providerKey: 'yunwu',
  failure: createAiProviderFailureAdapter('yunwu'),
  image: {
    describe: (selection) => describeMediaVariantBase({
      modality: 'image',
      selection,
      executionMode: 'sync',
      optionSchema: resolveYunwuOptionSchema('image', selection.modelId),
    }),
    execute: executeYunwuImageGeneration,
  },
}
