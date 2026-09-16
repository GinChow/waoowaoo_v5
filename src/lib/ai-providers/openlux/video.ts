import type { AiProviderVideoExecutionContext } from '@/lib/ai-providers/runtime-types'
import { readProviderJsonResponse } from '@/lib/ai-providers/failure'
import { requireSelectedModelId } from '@/lib/ai-providers/shared/model-selection'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import { AppError } from '@/lib/errors/app-error'
import { resolveOpenLuxBaseUrl } from './config'
import { assertOpenLuxResponse, rejectOpenLuxInput } from './http'
import { requireOpenLuxVideoModelSpec } from './video-models'

export const OPENLUX_VIDEO_TASKS_PATH = '/contents/generations/tasks'

type OpenLuxVideoContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role: 'first_frame' | 'last_frame' | 'reference_image' }
  | { type: 'video_url'; video_url: { url: string }; role: 'reference_video' }
  | { type: 'audio_url'; audio_url: { url: string }; role: 'reference_audio' }

export function openLuxVideoTasksUrl(baseUrl: string | undefined, taskId?: string): string {
  const root = `${resolveOpenLuxBaseUrl(baseUrl, 'ark')}${OPENLUX_VIDEO_TASKS_PATH}`
  return taskId ? `${root}/${encodeURIComponent(taskId)}` : root
}

export async function executeOpenLuxVideoGeneration(input: AiProviderVideoExecutionContext) {
  const options = input.options ?? {}
  const spec = requireOpenLuxVideoModelSpec(requireSelectedModelId(input.selection, 'openlux:video'))
  const firstFrame = input.imageUrl.trim()
  const referenceImages = options.referenceImages ?? []
  const referenceAudios = options.referenceAudios ?? []
  const referenceVideos = options.referenceVideos ?? []
  const hasReferences = referenceImages.length + referenceAudios.length + referenceVideos.length > 0

  // Frame media lives outside options; only actual-input relationships are
  // checked here. Option ranges and counts belong to the model schema.
  if (options.lastFrameImageUrl && !firstFrame) rejectOpenLuxInput('OPENLUX_VIDEO_LAST_FRAME_REQUIRES_FIRST_FRAME')
  if (firstFrame && hasReferences) rejectOpenLuxInput('OPENLUX_VIDEO_FRAME_CONFLICTS_WITH_REFERENCES')

  const content: OpenLuxVideoContentItem[] = []
  if (options.prompt?.trim()) content.push({ type: 'text', text: options.prompt.trim() })
  if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
  if (options.lastFrameImageUrl) content.push({ type: 'image_url', image_url: { url: options.lastFrameImageUrl }, role: 'last_frame' })
  for (const url of referenceImages) content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
  for (const url of referenceAudios) content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
  for (const url of referenceVideos) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
  if (content.length === 0) rejectOpenLuxInput('OPENLUX_VIDEO_INPUT_REQUIRED')

  const response = await fetchWithProviderProxy(openLuxVideoTasksUrl(input.providerConfig.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.providerConfig.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: spec.modelId,
      content,
      resolution: options.resolution,
      ratio: options.aspectRatio,
      duration: options.duration,
      // The gateway ignores false and always returns an audio track; the
      // schema only admits true, so the wire states what actually happens.
      generate_audio: true,
      watermark: false,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  await assertOpenLuxResponse(response)
  const payload = await readProviderJsonResponse<{ id?: unknown }>({ response, provider: 'openlux', phase: 'submit' })
  // Live gateway returns a numeric id string ("139513828"), not Ark's cgt-*.
  const taskId = typeof payload.id === 'string' ? payload.id.trim()
    : typeof payload.id === 'number' ? String(payload.id) : ''
  if (!taskId) throw new AppError('EMPTY_RESPONSE', 'OpenLux returned no video task id', { provider: 'openlux', cause: payload })
  return { success: true as const, async: true, requestId: taskId, externalId: `OPENLUX:VIDEO:${taskId}` }
}
