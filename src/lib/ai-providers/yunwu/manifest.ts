import { defineAiProviderManifest } from '@/lib/ai-providers/manifest'
import { yunwuAdapter } from './adapter'
import { YUNWU_DEFAULT_BASE_URL } from './config'
import {
  YUNWU_API_CONFIG_CATALOG_MODELS,
  YUNWU_BUILTIN_CAPABILITY_CATALOG_ENTRIES,
  YUNWU_BUILTIN_PRICING_CATALOG_ENTRIES,
} from './models'

export const yunwuProviderManifest = defineAiProviderManifest({
  providerKey: 'yunwu',
  adapter: yunwuAdapter,
  apiConfig: {
    visibility: 'visible',
    name: 'Yunwu',
    baseUrl: YUNWU_DEFAULT_BASE_URL,
  },
  platformCredentials: {
    envPrefix: 'PLATFORM_YUNWU',
    requiresBaseUrl: true,
  },
  catalogs: {
    capabilities: YUNWU_BUILTIN_CAPABILITY_CATALOG_ENTRIES,
    pricing: YUNWU_BUILTIN_PRICING_CATALOG_ENTRIES,
    apiConfigModels: YUNWU_API_CONFIG_CATALOG_MODELS,
    platformModels: [],
  },
  mediaInputs: [
    { modality: 'image', transports: { image: ['public-https'] } },
  ],
})
