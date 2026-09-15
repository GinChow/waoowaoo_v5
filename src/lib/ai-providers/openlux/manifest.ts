import { defineAiProviderManifest } from '@/lib/ai-providers/manifest'
import { openLuxAdapter } from './adapter'
import { OPENLUX_DEFAULT_BASE_URL } from './config'
import { OPENLUX_API_CONFIG_MODELS, OPENLUX_CAPABILITIES } from './models'
import { OPENLUX_PRICING } from './pricing'

const BOTH_TRANSPORTS = ['public-https', 'inline-data-url'] as const

export const openLuxProviderManifest = defineAiProviderManifest({
  providerKey: 'openlux', adapter: openLuxAdapter,
  apiConfig: { visibility: 'visible', name: 'OpenLux', baseUrl: OPENLUX_DEFAULT_BASE_URL },
  platformCredentials: { envPrefix: 'PLATFORM_OPENLUX', requiresBaseUrl: true },
  catalogs: { capabilities: OPENLUX_CAPABILITIES, pricing: OPENLUX_PRICING,
    apiConfigModels: OPENLUX_API_CONFIG_MODELS, platformModels: [] },
  mediaInputs: [
    { modality: 'vision', transports: { image: BOTH_TRANSPORTS } },
    { modality: 'image', transports: { image: BOTH_TRANSPORTS } },
  ],
})
