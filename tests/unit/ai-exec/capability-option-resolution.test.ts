import { describe, expect, it } from 'vitest'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { AiOptionValidationError } from '@/lib/ai-exec/normalize'
import { resolveModelCapabilityGenerationOptions } from '@/lib/config-service'

// Oracle: the production metaso manifest declares MiniMax-H3 with
// generateAudioOptions [true]; the option is not fixed here so the caller
// must supply it. A missing or disallowed value is caller input, so the
// failure must be the typed option-validation error that media preflight
// classifies as INVALID_PARAMS, never a bare Error that degrades to
// INTERNAL_ERROR/SYSTEM/stop.
const MODEL_KEY = 'metaso::MiniMax-H3'
const COMPLETE_SELECTIONS = {
  generationMode: 'normal',
  duration: 6,
  resolution: '768P',
  generateAudio: true,
} as const

describe('resolveModelCapabilityGenerationOptions', () => {
  it('reports a missing required capability field as a typed required_option failure', () => {
    ensureAiCatalogsRegistered()
    const withoutAudio = Object.fromEntries(
      Object.entries(COMPLETE_SELECTIONS).filter(([field]) => field !== 'generateAudio'),
    )
    let thrown: unknown
    try {
      resolveModelCapabilityGenerationOptions({
        modelType: 'video',
        modelKey: MODEL_KEY,
        capabilityDefaults: {},
        runtimeSelections: withoutAudio,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AiOptionValidationError)
    if (!(thrown instanceof AiOptionValidationError)) return
    expect(thrown.failure).toBe('required_option')
    expect(thrown.field).toBe('generateAudio')
    expect(thrown.context).toBe(MODEL_KEY)
  })

  it('reports a disallowed capability value as a typed invalid_option failure', () => {
    ensureAiCatalogsRegistered()
    let thrown: unknown
    try {
      resolveModelCapabilityGenerationOptions({
        modelType: 'video',
        modelKey: MODEL_KEY,
        capabilityDefaults: {},
        runtimeSelections: { ...COMPLETE_SELECTIONS, generateAudio: false },
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AiOptionValidationError)
    if (!(thrown instanceof AiOptionValidationError)) return
    expect(thrown.failure).toBe('invalid_option')
    expect(thrown.field).toBe('generateAudio')
  })

  it('returns the resolved options when every required field is supplied', () => {
    ensureAiCatalogsRegistered()
    expect(resolveModelCapabilityGenerationOptions({
      modelType: 'video',
      modelKey: MODEL_KEY,
      capabilityDefaults: {},
      runtimeSelections: COMPLETE_SELECTIONS,
    })).toEqual(COMPLETE_SELECTIONS)
  })
})
