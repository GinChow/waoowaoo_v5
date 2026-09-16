import { requireArkVideoModelSpec, type ArkVideoModelSpec } from '@/lib/ai-providers/ark/video-models'
import { buildVideoOptionSchema } from '@/lib/ai-providers/shared/option-schema'
import type { AiOptionSchema, VideoCapabilities } from '@/lib/ai-registry/types'

// OpenLux passes the Ark Seedance protocol through unchanged (verified
// 2026-09-16 with test_api/src/openlux-seedance2.ts), so the model constraints
// are the Ark ones. Only these two models are offered on the gateway.
export const OPENLUX_VIDEO_MODELS = [
  ['doubao-seedance-2-0-260128', 'Seedance 2.0'],
  ['doubao-seedance-2-0-fast-260128', 'Seedance 2.0 Fast'],
] as const

// Ark itself accepts adaptive; the gateway's frame ratio stays selected, so
// the product ratio catalog is the wire ratio.
export const OPENLUX_VIDEO_ASPECT_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const

export function requireOpenLuxVideoModelSpec(modelId: string): ArkVideoModelSpec {
  if (!OPENLUX_VIDEO_MODELS.some(([id]) => id === modelId)) {
    throw new Error(`OPENLUX_VIDEO_MODEL_UNSUPPORTED:${modelId}`)
  }
  return requireArkVideoModelSpec(modelId)
}

export function openLuxVideoCapabilities(modelId: string): VideoCapabilities {
  const spec = requireOpenLuxVideoModelSpec(modelId)
  return {
    supportedInputModes: ['text_to_video', 'first_frame', 'first_last_frame', 'reference'],
    supportsTextToVideo: true,
    generationModeOptions: ['normal', 'firstlastframe'],
    // The gateway returns an audio track even when generate_audio is false
    // (verified 2026-09-16), so the switch is not offered.
    generateAudioOptions: [true],
    durationOptions: Array.from({ length: spec.durationMax - spec.durationMin + 1 }, (_, i) => spec.durationMin + i),
    resolutionOptions: [...spec.resolutions],
    firstlastframe: true,
    firstFrameAspectRatio: spec.frameRatio,
    supportGenerateAudio: true,
    assetReferenceMultiReference: true,
    maxReferenceImages: spec.maxReferenceImages,
    maxReferenceAudios: spec.maxReferenceAudios,
    maxReferenceVideos: spec.maxReferenceVideos,
    maxReferenceFiles: spec.maxReferenceFiles,
    referenceAudioRequiresVisual: spec.referenceAudioRequiresVisual,
    minReferenceAudioDurationMs: spec.minReferenceAudioDurationMs,
    maxReferenceAudioDurationMs: spec.maxReferenceAudioDurationMs,
    maxTotalReferenceAudioDurationMs: spec.maxTotalReferenceAudioDurationMs,
    minReferenceVideoDurationMs: spec.minReferenceVideoDurationMs,
    maxReferenceVideoDurationMs: spec.maxReferenceVideoDurationMs,
    maxTotalReferenceVideoDurationMs: spec.maxTotalReferenceVideoDurationMs,
  }
}

export function resolveOpenLuxVideoOptionSchema(modelId: string): AiOptionSchema {
  const spec = requireOpenLuxVideoModelSpec(modelId)
  return buildVideoOptionSchema({
    capabilities: openLuxVideoCapabilities(modelId),
    aspectRatios: OPENLUX_VIDEO_ASPECT_RATIOS,
    objectValidators: [(options) => {
      const images = Array.isArray(options.referenceImages) ? options.referenceImages.length : 0
      const audios = Array.isArray(options.referenceAudios) ? options.referenceAudios.length : 0
      const videos = Array.isArray(options.referenceVideos) ? options.referenceVideos.length : 0
      if (images + audios + videos > spec.maxReferenceFiles) return { ok: false, reason: `max_reference_files=${spec.maxReferenceFiles}` }
      if (spec.referenceAudioRequiresVisual && audios > 0 && images + videos === 0) return { ok: false, reason: 'reference_audio_requires_visual' }
      if (options.lastFrameImageUrl !== undefined && images + audios + videos > 0) return { ok: false, reason: 'last_frame_conflicts_with_references' }
      return { ok: true }
    }],
  })
}
