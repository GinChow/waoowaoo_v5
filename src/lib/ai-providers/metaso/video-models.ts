import { buildVideoOptionSchema } from '@/lib/ai-providers/shared/option-schema'
import type { AiOptionSchema, VideoCapabilities } from '@/lib/ai-registry/types'

// MiniMax v2 video generation (official docs, fetched 2026-09-16):
// https://platform.minimax.cn/docs/api-reference/video-generation-v2-create
// Resolution values are the provider's own spelling and are sent verbatim.
export type MetasoVideoResolution = '480P' | '768P' | '2K'

export interface MetasoVideoModelSpec {
  readonly modelId: string
  readonly name: string
  readonly durationMin: number
  readonly durationMax: number
  readonly resolutions: readonly MetasoVideoResolution[]
}

export const METASO_VIDEO_MODELS: readonly MetasoVideoModelSpec[] = [
  { modelId: 'MiniMax-H3', name: 'MiniMax H3', durationMin: 4, durationMax: 15, resolutions: ['768P', '2K'] },
  { modelId: 'MiniMax-H3-Max', name: 'MiniMax H3 Max', durationMin: 5, durationMax: 15, resolutions: ['480P', '768P'] },
]

// Official ratio list minus adaptive: the adapter sends adaptive itself when a
// first frame is present, and text-only requests may not use it.
export const METASO_VIDEO_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const

// Official limits shared by both models: reference images <= 9, reference
// videos <= 3, reference audios <= 3; each audio/video clip 2-15 s with the
// per-channel total <= 15 s; video MP4/MOV <= 50 MB.
const h3References = {
  maxReferenceImages: 9,
  maxReferenceAudios: 3,
  maxReferenceVideos: 3,
  maxReferenceFiles: 15,
  referenceAudioRequiresVisual: false,
  minReferenceAudioDurationMs: 2_000,
  maxReferenceAudioDurationMs: 15_000,
  maxTotalReferenceAudioDurationMs: 15_000,
  minReferenceVideoDurationMs: 2_000,
  maxReferenceVideoDurationMs: 15_000,
  maxTotalReferenceVideoDurationMs: 15_000,
  referenceVideoMimeTypes: ['video/mp4', 'video/quicktime'],
  maxTotalReferenceVideoBytes: 50_000_000,
} as const

export const METASO_VIDEO_PROMPT_MAX_CHARS = 7000

export function requireMetasoVideoModelSpec(modelId: string): MetasoVideoModelSpec {
  const spec = METASO_VIDEO_MODELS.find((model) => model.modelId === modelId)
  if (!spec) throw new Error(`METASO_VIDEO_MODEL_UNSUPPORTED:${modelId}`)
  return spec
}

export function metasoVideoCapabilities(modelId: string): VideoCapabilities {
  const spec = requireMetasoVideoModelSpec(modelId)
  return {
    supportedInputModes: ['text_to_video', 'first_frame', 'first_last_frame', 'reference'],
    supportsTextToVideo: true,
    generationModeOptions: ['normal', 'firstlastframe'],
    // H3 always produces an audio track; there is no wire switch.
    generateAudioOptions: [true],
    durationOptions: Array.from({ length: spec.durationMax - spec.durationMin + 1 }, (_, i) => spec.durationMin + i),
    resolutionOptions: [...spec.resolutions],
    firstlastframe: true,
    firstFrameAspectRatio: 'adaptive',
    supportGenerateAudio: true,
    assetReferenceMultiReference: true,
    ...h3References,
    referenceVideoMimeTypes: [...h3References.referenceVideoMimeTypes],
  }
}

export function resolveMetasoVideoOptionSchema(modelId: string): AiOptionSchema {
  return buildVideoOptionSchema({
    capabilities: metasoVideoCapabilities(modelId),
    aspectRatios: METASO_VIDEO_ASPECT_RATIOS,
    objectValidators: [(options) => {
      const images = Array.isArray(options.referenceImages) ? options.referenceImages.length : 0
      const audios = Array.isArray(options.referenceAudios) ? options.referenceAudios.length : 0
      const videos = Array.isArray(options.referenceVideos) ? options.referenceVideos.length : 0
      if (images + audios + videos > h3References.maxReferenceFiles) return { ok: false, reason: `max_reference_files=${h3References.maxReferenceFiles}` }
      if (options.lastFrameImageUrl !== undefined && images + audios + videos > 0) return { ok: false, reason: 'last_frame_conflicts_with_references' }
      return { ok: true }
    }],
  })
}
