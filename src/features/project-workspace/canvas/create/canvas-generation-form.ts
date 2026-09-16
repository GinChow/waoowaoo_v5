import { validateGenerationReferenceDurations } from '@/lib/ai-registry/generation-reference-duration'
import { generationVideoInputMode, type GenerationReferenceRole } from '@/lib/ai-registry/generation-reference-policy'
import type { CapabilityValue } from '@/lib/ai-registry/types'
import { canvasReferenceIssue, type CanvasGenerationCapability } from './canvas-draft'

export interface CanvasGenerationFormInput {
  readonly configurationVersion: string | null
  readonly aspectRatio: string | null
  /**
   * The frame is owned by the asset format policy (character/location/prop):
   * the Operation schema forbids `options.aspectRatio` and the server resolves
   * the fixed format, so the form neither offers nor requires a choice.
   */
  readonly aspectRatioLocked?: boolean
  readonly durationSeconds: number | null
  readonly parameters: Readonly<Record<string, CapabilityValue>>
  readonly references: readonly GenerationReferenceRole[]
}

export function canvasUsesAdaptiveFrame(capability: CanvasGenerationCapability | null, references: readonly GenerationReferenceRole[]): boolean {
  const mode = generationVideoInputMode(references)
  return capability?.mediaType === 'video' && capability.view.firstFrameAspectRatio === 'adaptive'
    && (mode === 'first_frame' || mode === 'first_last_frame')
}

/** Only fields currently owned by the manual editor enter a new request. */
export function canvasEditableParameters(capability: CanvasGenerationCapability | null, values: CanvasGenerationFormInput['parameters']) {
  return Object.fromEntries((capability?.view.parameters ?? []).flatMap(({ field }) => (
    values[field] === undefined ? [] : [[field, values[field]]]
  ))) as Record<string, CapabilityValue>
}

export function canvasGenerationFormIssues(capability: CanvasGenerationCapability | null, input: CanvasGenerationFormInput): readonly string[] {
  if (!capability) return ['MODEL_UNAVAILABLE']
  if (capability.view.unavailableReason) return ['MODEL_CONFIGURATION_UNAVAILABLE']
  const issues: string[] = []
  if (input.configurationVersion !== capability.view.configurationVersion) issues.push('CONFIGURATION_CHANGED')
  if (!input.aspectRatioLocked && (!input.aspectRatio || !capability.view.aspectRatios.includes(input.aspectRatio))) issues.push('ASPECT_RATIO_REQUIRED')
  if (capability.mediaType === 'video' && (input.durationSeconds === null || !capability.view.durationsSeconds.includes(input.durationSeconds))) issues.push('DURATION_REQUIRED')
  if (capability.view.parameters.some((parameter) => {
    const value = input.parameters[parameter.field]
    return value === undefined ? parameter.required : !parameter.options.includes(value)
  })) issues.push('PARAMETERS_REQUIRED')
  const referenceIssue = canvasReferenceIssue(capability, input.references)
  if (referenceIssue) issues.push(referenceIssue.code)
  if (capability.mediaType === 'video') for (const channel of ['audio', 'video'] as const) {
    const durationIssue = validateGenerationReferenceDurations(channel, capability.view.referenceDurationLimits[channel], input.references.filter((reference) => reference.channel === channel))
    if (durationIssue) issues.push(durationIssue.code)
  }
  return issues
}
