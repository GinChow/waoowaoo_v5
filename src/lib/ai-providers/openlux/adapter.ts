import type { AiProviderAdapter } from '@/lib/ai-providers/runtime-types'
import { createAiProviderFailureAdapter } from '@/lib/ai-providers/failure'
import { describeMediaVariantBase } from '@/lib/ai-providers/shared/media-adapter'
import { createAiSdkConnectionTester } from '@/lib/ai-providers/shared/connection-test'
import { OPENLUX_DEFAULT_BASE_URL, resolveOpenLuxBaseUrl } from './config'
import { executeOpenLuxImage } from './image'
import { createOpenLuxLanguageModel, validateOpenLuxLanguageModelResult } from './language-model'
import { isOpenLuxGptModel, resolveOpenLuxImageOptionSchema } from './models'

const failure = createAiProviderFailureAdapter('openlux')
const testerDefaults = { providerKey: 'openlux', failure, displayName: 'OpenLux', defaultBaseUrl: OPENLUX_DEFAULT_BASE_URL,
  createLanguageModel: createOpenLuxLanguageModel } as const
// Each wire needs its own probe model; the /v1/models diagnosis is shared.
const connectionTester = createAiSdkConnectionTester({ ...testerDefaults, defaultTestModel: 'gemini-3.8-flash', protocol: 'google-generative-ai' })
const responsesConnectionTester = createAiSdkConnectionTester({ ...testerDefaults, defaultTestModel: 'gpt-5.6-luna', protocol: 'openai-responses' })

export const openLuxAdapter: AiProviderAdapter = {
  providerKey: 'openlux', failure,
  image: {
    describe: (selection) => describeMediaVariantBase({ modality: 'image', selection, executionMode: 'sync',
      optionSchema: resolveOpenLuxImageOptionSchema(selection.modelId) }),
    execute: executeOpenLuxImage,
  },
  languageModel: { create: createOpenLuxLanguageModel, validateResult: validateOpenLuxLanguageModelResult },
  connectionTest: {
    ...connectionTester,
    testLlm: (input) => (isOpenLuxGptModel(input.model ?? '') ? responsesConnectionTester : connectionTester).testLlm!(input),
    diagnose: (input) => connectionTester.diagnose({ ...input, baseUrl: resolveOpenLuxBaseUrl(input.baseUrl, 'v1') }),
  },
}
