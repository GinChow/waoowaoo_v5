import { METASO_VIDEO_MODELS, metasoVideoCapabilities } from './video-models'

export const METASO_API_CONFIG_MODELS = METASO_VIDEO_MODELS.map(({ modelId, name }) => ({
  provider: 'metaso', modelId, name, type: 'video' as const,
}))

export const METASO_CAPABILITIES = METASO_VIDEO_MODELS.map(({ modelId }) => ({
  provider: 'metaso', modelId, modelType: 'video' as const,
  capabilities: { video: metasoVideoCapabilities(modelId) },
}))
