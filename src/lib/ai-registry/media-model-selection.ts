import type { ModelCapabilities, UnifiedModelType } from './types'

/**
 * Music production executes the user's composition plan without compiling a
 * prompt. The llm slot is the Codex assistant slot, and the model gateway
 * proxies the OpenAI Responses wire byte-for-byte, so only a registry entry
 * with a verified Responses wire can serve it.
 */
export function isProductionModelSupported(type: UnifiedModelType, capabilities: ModelCapabilities | undefined): boolean {
  if (type === 'music') {
    return Boolean(
      capabilities?.music?.generationModes?.includes('composition_plan') && capabilities.music.compositionPlan,
    )
  }
  if (type === 'llm') return capabilities?.llm?.codexRuntimeWireApi === 'responses'
  return true
}

export const MEDIA_MODEL_TYPES = ['image', 'video', 'music', 'voice'] as const
export type MediaModelType = typeof MEDIA_MODEL_TYPES[number]

/** Every model type the user picks exactly one model for, in presentation order. */
export const MODEL_SLOT_TYPES = ['llm', 'image', 'video', 'music', 'voice'] as const

export type ModelSlotTier = 'core' | 'extension'

/** Product weighting of each slot; `extension` slots are optional add-ons. */
export const MODEL_SLOT_TIER = {
  llm: 'core',
  image: 'core',
  video: 'core',
  music: 'extension',
  voice: 'extension',
} as const satisfies Record<UnifiedModelType, ModelSlotTier>

export function getModelSlotTypesByTier(tier: ModelSlotTier): UnifiedModelType[] {
  return MODEL_SLOT_TYPES.filter((type) => MODEL_SLOT_TIER[type] === tier)
}

export type MediaModelSelection<T> =
  | { readonly status: 'disabled' }
  | { readonly status: 'selected'; readonly model: T }
  | { readonly status: 'ambiguous'; readonly modelKeys: readonly string[] }

/** Stored membership is the single selection fact for a slot, not a preference pool. */
export function resolveSingleModelSelection<T extends { type: UnifiedModelType; modelKey: string }>(
  models: readonly T[],
  type: UnifiedModelType,
): MediaModelSelection<T> {
  const matches = models.filter((model) => model.type === type)
  if (matches.length === 0) return { status: 'disabled' }
  if (matches.length > 1) return { status: 'ambiguous', modelKeys: matches.map((model) => model.modelKey) }
  return { status: 'selected', model: matches[0] }
}
