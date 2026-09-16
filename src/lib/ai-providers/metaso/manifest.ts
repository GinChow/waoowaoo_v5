import { defineAiProviderManifest } from '@/lib/ai-providers/manifest'
import { metasoAdapter } from './adapter'
import { metasoAsyncTaskProvider } from './async-task'
import { METASO_DEFAULT_BASE_URL } from './config'
import { METASO_API_CONFIG_MODELS, METASO_CAPABILITIES } from './models'
import { METASO_PRICING } from './pricing'

// MiniMax accepts data URIs for image, video and audio inputs alike.
const BOTH_TRANSPORTS = ['public-https', 'inline-data-url'] as const

export const metasoProviderManifest = defineAiProviderManifest({
  providerKey: 'metaso', adapter: metasoAdapter,
  apiConfig: { visibility: 'visible', name: 'Metaso', baseUrl: METASO_DEFAULT_BASE_URL },
  platformCredentials: { envPrefix: 'PLATFORM_METASO', requiresBaseUrl: true },
  asyncTasks: [metasoAsyncTaskProvider],
  catalogs: { capabilities: METASO_CAPABILITIES, pricing: METASO_PRICING,
    apiConfigModels: METASO_API_CONFIG_MODELS, platformModels: [] },
  mediaInputs: [
    { modality: 'video', transports: { image: BOTH_TRANSPORTS, audio: BOTH_TRANSPORTS, video: BOTH_TRANSPORTS } },
  ],
})
