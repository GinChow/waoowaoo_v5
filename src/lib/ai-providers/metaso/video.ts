import type { AiProviderVideoExecutionContext } from '@/lib/ai-providers/runtime-types'
import { readProviderJsonResponse } from '@/lib/ai-providers/failure'
import { requireSelectedModelId } from '@/lib/ai-providers/shared/model-selection'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import { AppError } from '@/lib/errors/app-error'
import { resolveMetasoBaseUrl } from './config'
import { assertMetasoSubmissionResponse, rejectMetasoInput } from './http'
import { METASO_VIDEO_PROMPT_MAX_CHARS, requireMetasoVideoModelSpec } from './video-models'

export const METASO_VIDEO_CREATE_PATH = '/v2/video_generation'
export const METASO_VIDEO_QUERY_PATH = '/v2/query/video_generation'

type MetasoVideoContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role: 'first_frame' | 'last_frame' | 'reference_image' }
  | { type: 'video_url'; video_url: { url: string }; role: 'reference_video' }
  | { type: 'audio_url'; audio_url: { url: string }; role: 'reference_audio' }

export async function executeMetasoVideoGeneration(input: AiProviderVideoExecutionContext) {
  const options = input.options ?? {}
  const spec = requireMetasoVideoModelSpec(requireSelectedModelId(input.selection, 'metaso:video'))
  const prompt = options.prompt?.trim() ?? ''
  const firstFrame = input.imageUrl.trim()
  const referenceImages = options.referenceImages ?? []
  const referenceAudios = options.referenceAudios ?? []
  const referenceVideos = options.referenceVideos ?? []
  const hasReferences = referenceImages.length + referenceAudios.length + referenceVideos.length > 0

  // MiniMax requires exactly one non-empty text item and forbids mixing frame
  // images with multimodal references. Option ranges belong to the schema.
  if (!prompt || [...prompt].length > METASO_VIDEO_PROMPT_MAX_CHARS) rejectMetasoInput('METASO_VIDEO_PROMPT_MUST_BE_1_TO_7000_CHARACTERS')
  if (options.lastFrameImageUrl && !firstFrame) rejectMetasoInput('METASO_VIDEO_LAST_FRAME_REQUIRES_FIRST_FRAME')
  if (firstFrame && hasReferences) rejectMetasoInput('METASO_VIDEO_FRAME_CONFLICTS_WITH_REFERENCES')
  // Text-only generation must carry an explicit ratio; a first frame decides the ratio itself.
  const ratio = firstFrame ? 'adaptive' : options.aspectRatio
  if (!ratio || ratio === 'adaptive' && !firstFrame) rejectMetasoInput('METASO_VIDEO_RATIO_REQUIRED')

  const content: MetasoVideoContentItem[] = [{ type: 'text', text: prompt }]
  if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
  if (options.lastFrameImageUrl) content.push({ type: 'image_url', image_url: { url: options.lastFrameImageUrl }, role: 'last_frame' })
  for (const url of referenceImages) content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
  for (const url of referenceVideos) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
  for (const url of referenceAudios) content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })

  const response = await fetchWithProviderProxy(`${resolveMetasoBaseUrl(input.providerConfig.baseUrl)}${METASO_VIDEO_CREATE_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.providerConfig.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: spec.modelId,
      content,
      resolution: options.resolution,
      duration: options.duration,
      ratio,
      aigc_watermark: false,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  await assertMetasoSubmissionResponse(response)
  const payload = await readProviderJsonResponse<{ task_id?: unknown }>({ response, provider: 'metaso', phase: 'submit' })
  const taskId = typeof payload.task_id === 'string' ? payload.task_id.trim() : ''
  if (!taskId) throw new AppError('EMPTY_RESPONSE', 'Metaso returned no video task id', { provider: 'metaso', cause: payload })
  return { success: true as const, async: true, requestId: taskId, externalId: `METASO:VIDEO:${taskId}` }
}
