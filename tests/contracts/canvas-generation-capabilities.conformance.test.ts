import { describe, expect, it } from 'vitest'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { normalizeMediaOptionsForSelection } from '@/lib/ai-exec/media-preflight'
import { buildApiConfigServerCatalog } from '@/lib/ai-registry/api-config-catalog'
import { validateGenerationReferences } from '@/lib/ai-registry/generation-reference-policy'
import type { AiResolvedSelection, CapabilityValue } from '@/lib/ai-registry/types'
import { calcImage, calcVideo } from '@/lib/billing/cost'
import { projectProductionCapabilities, assertProductionConfigurationVersion, type ProjectProductionContext } from '@/lib/project-production-context'
import { projectWorkspaceCanvasGenerationCapabilities, type WorkspaceCanvasGenerationParameterView } from '@/lib/workspace-resource/canvas-generation-capabilities'
import { PROJECT_ASSISTANT_MEDIA_ATTACHMENT_MAX_FILES } from '@/lib/project-agent/media-attachments/types'
import { canvasGenerationFormIssues } from '@/features/project-workspace/canvas/create/canvas-generation-form'
import { canvasDraftReferenceRoles, type CanvasGenerationCapability } from '@/features/project-workspace/canvas/create/canvas-draft'

ensureAiCatalogsRegistered()
const models = buildApiConfigServerCatalog().models.filter((model) => model.type === 'image' || model.type === 'video')

function contextFor(model: typeof models[number]): ProjectProductionContext {
  return {
    schemaVersion: 8, version: 'conformance-configuration', fixedParameters: {},
    project: { projectId: 'conformance', name: 'Conformance', description: null, videoRatio: '16:9', videoResolution: '720p', imageResolution: '2K' },
    productionCapabilities: projectProductionCapabilities({ videoRatio: '16:9', models: [{ ...model, modelKey: `${model.provider}::${model.modelId}`, price: 0 }] }),
  }
}

function combinations(fields: readonly WorkspaceCanvasGenerationParameterView[]): Record<string, CapabilityValue>[] {
  return fields.reduce<Record<string, CapabilityValue>[]>((rows, field) => rows.flatMap((row) => field.options.map((option) => ({ ...row, [field.field]: option }))), [{}])
}

describe('Canvas generation capability registry conformance', () => {
  it('every offered image/video tuple passes native option validation and the real quote resolver', () => {
    for (const model of models) {
      const projected = projectWorkspaceCanvasGenerationCapabilities(contextFor(model))
      const view = model.type === 'image' ? projected.image : projected.video
      expect(view, model.modelId).not.toBeNull()
      expect(view!.unavailableReason, model.modelId).toBeNull()
      const selection: AiResolvedSelection = { provider: model.provider, modelId: model.modelId, modelKey: `${model.provider}::${model.modelId}`, variantSubKind: 'official' }
      for (const parameters of combinations(view!.parameters)) for (const aspectRatio of view!.aspectRatios) {
        if (model.type === 'image') {
          for (const count of [0, view!.maxReferenceImages]) {
            const options = { ...parameters, aspectRatio, referenceImages: Array.from({ length: count }, () => 'https://example.com/input.png') }
            const normalized = normalizeMediaOptionsForSelection({ selection, modality: 'image', options })
            expect(calcImage(selection.modelKey, 1, { ...normalized, referenceImageCount: count }), model.modelId).toBeGreaterThan(0)
            if (count > 0) expect(() => normalizeMediaOptionsForSelection({ selection, modality: 'image', options: { ...options, referenceImages: [...options.referenceImages, 'https://example.com/extra.png'] } })).toThrow()
          }
        } else {
          const video = projected.video!
          for (const duration of video.durationsSeconds) for (const mode of video.supportedInputModes) {
            const imageCounts = mode === 'reference'
              ? Array.from({ length: video.maxReferenceImages + 1 }, (_, count) => count)
              : [mode === 'first_last_frame' ? 2 : mode === 'first_frame' ? 1 : 0]
            for (const referenceImageCount of imageCounts) for (const containsVideoInput of mode === 'reference' && video.maxReferenceVideos > 0 ? [false, true] : [false]) {
              const options = { ...parameters, aspectRatio, duration }
              normalizeMediaOptionsForSelection({ selection, modality: 'video', options })
              expect(calcVideo(selection.modelKey, String(parameters.resolution), 1, {
                ...options, generationMode: 'normal', containsVideoInput, referenceImageCount,
                containsFirstFrame: mode === 'first_frame' || mode === 'first_last_frame',
              }), `${model.modelId}:${mode}`).toBeGreaterThan(0)
            }
          }
        }
      }
    }
  })

  it('offers only complete reference sets, honors image attachment transport, and requires every exposed field', () => {
    for (const model of models) {
      const view = projectWorkspaceCanvasGenerationCapabilities(contextFor(model))
      const capability: CanvasGenerationCapability = model.type === 'image'
        ? { mediaType: 'image', view: view.assistantImage! }
        : { mediaType: 'video', view: view.assistantVideo! }
      expect(capability.view.maxReferenceImages).toBeLessThanOrEqual(PROJECT_ASSISTANT_MEDIA_ATTACHMENT_MAX_FILES)
      if (capability.mediaType === 'video') {
        const references: { channel: 'image'; role: string }[] = []
        for (let index = 0; index <= capability.view.maxReferenceImages + 2; index++) {
          const roles = canvasDraftReferenceRoles('video', 'image', capability, references)
          for (const role of roles) {
            expect(validateGenerationReferences({ mediaType: 'video', limits: capability.view, references: [...references, { channel: 'image', role }] })).toBeNull()
          }
          if (!roles.length) break
          references.push({ channel: 'image', role: roles[0] })
        }
      }
      const parameters = combinations(capability.view.parameters)[0]
      const valid = {
        configurationVersion: view.version, parameters, references: [],
        aspectRatio: capability.view.aspectRatios[0],
        durationSeconds: capability.mediaType === 'video' ? capability.view.durationsSeconds[0] : null,
      }
      expect(canvasGenerationFormIssues(capability, valid), model.modelId).toEqual([])
      for (const { field } of capability.view.parameters) {
        const missing = { ...parameters }
        delete missing[field]
        expect(canvasGenerationFormIssues(capability, { ...valid, parameters: missing })).toContain('PARAMETERS_REQUIRED')
      }
      expect(canvasGenerationFormIssues(capability, { ...valid, configurationVersion: 'previous' })).toContain('CONFIGURATION_CHANGED')
      expect(canvasGenerationFormIssues(capability, { ...valid, aspectRatio: null })).toContain('ASPECT_RATIO_REQUIRED')
      if (capability.mediaType === 'image') {
        // Asset images (character/location/prop) carry no aspectRatio: the
        // Operation schema forbids it and the server resolves the fixed format.
        expect(canvasGenerationFormIssues(capability, { ...valid, aspectRatio: null, aspectRatioLocked: true }), model.modelId).toEqual([])
      }
      expect(() => assertProductionConfigurationVersion(contextFor(model), 'previous')).toThrow()
    }
  })
})
