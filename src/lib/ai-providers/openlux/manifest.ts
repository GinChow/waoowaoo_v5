import { defineAiProviderManifest } from '@/lib/ai-providers/manifest'
import { openLuxAdapter } from './adapter'
import { openLuxAsyncTaskProvider } from './async-task'
import { OPENLUX_DEFAULT_BASE_URL } from './config'
import { OPENLUX_API_CONFIG_MODELS, OPENLUX_CAPABILITIES } from './models'
import { OPENLUX_PRICING } from './pricing'

const BOTH_TRANSPORTS = ['public-https', 'inline-data-url'] as const
const PUBLIC_HTTPS_ONLY = ['public-https'] as const

export const openLuxProviderManifest = defineAiProviderManifest({
  providerKey: 'openlux', adapter: openLuxAdapter,
  apiConfig: { visibility: 'visible', name: 'OpenLux', baseUrl: OPENLUX_DEFAULT_BASE_URL },
  platformCredentials: { envPrefix: 'PLATFORM_OPENLUX', requiresBaseUrl: true },
  asyncTasks: [openLuxAsyncTaskProvider],
  catalogs: { capabilities: OPENLUX_CAPABILITIES, pricing: OPENLUX_PRICING,
    apiConfigModels: OPENLUX_API_CONFIG_MODELS, platformModels: [] },
  mediaInputs: [
    { modality: 'vision', transports: { image: BOTH_TRANSPORTS } },
    { modality: 'image', transports: { image: BOTH_TRANSPORTS } },
    // Ark passthrough: images and audio may be inlined, reference video must be a URL.
    { modality: 'video', transports: { image: BOTH_TRANSPORTS, audio: BOTH_TRANSPORTS, video: PUBLIC_HTTPS_ONLY } },
  ],
})
