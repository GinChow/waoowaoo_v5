import type { AiProviderAdapter } from '@/lib/ai-providers/runtime-types'
import { createAiProviderFailureAdapter } from '@/lib/ai-providers/failure'
import { describeMediaVariantBase } from '@/lib/ai-providers/shared/media-adapter'
import { executeMetasoVideoGeneration } from './video'
import { resolveMetasoVideoOptionSchema } from './video-models'

export const metasoAdapter: AiProviderAdapter = {
  providerKey: 'metaso',
  failure: createAiProviderFailureAdapter('metaso'),
  video: {
    describe: (selection) => describeMediaVariantBase({ modality: 'video', selection, executionMode: 'async',
      optionSchema: resolveMetasoVideoOptionSchema(selection.modelId) }),
    execute: executeMetasoVideoGeneration,
  },
}
