import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAsyncTaskProviderByExternalId, tryResolveAiProviderAdapter } from '@/lib/ai-providers'
import { normalizeAiOptions } from '@/lib/ai-exec/normalize'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { calcVideo } from '@/lib/billing/cost'
import { resolveBuiltinPricing } from '@/lib/ai-registry/pricing-resolution'
import { modelAspectRatios } from '@/lib/ai-registry/model-aspect-ratios'
import { startScenarioServer } from '../../helpers/fakes/scenario-server'

ensureAiCatalogsRegistered()

const CREATE = '/relay/v2/video_generation'
const QUERY = '/relay/v2/query/video_generation'

// Protocol oracle: MiniMax v2 video docs (2026-09-16) relayed unchanged by
// Metaso, live-verified with test_api/src/metaso-minimax-h3.ts: { task_id } on
// create, { task: { status, content: { url } } } on query, queued -> running
// -> succeeded, failed | cancelled terminal.
describe('Metaso provider protocol', () => {
  let server: Awaited<ReturnType<typeof startScenarioServer>>
  beforeEach(async () => { server = await startScenarioServer() })
  afterEach(async () => { await server.close() })

  function adapter() {
    const result = tryResolveAiProviderAdapter('metaso')
    expect(result, 'Metaso must be executable through the provider registry').not.toBeNull()
    return result!
  }

  const providerConfig = () => ({ id: 'metaso', name: 'Metaso', apiKey: 'test-key', baseUrl: `${server.baseUrl}/relay/` })

  function videoOptions(modelId: string, options: Record<string, unknown>) {
    const selection = { provider: 'metaso', modelId, modelKey: `metaso::${modelId}`, variantSubKind: 'official' as const }
    return normalizeAiOptions({ schema: adapter().video!.describe(selection).optionSchema, options, context: 'metaso-video-test' })
  }

  async function video(modelId: string, options: Record<string, unknown>, imageUrl = '') {
    return adapter().video!.execute({
      userId: 'test-user',
      providerConfig: providerConfig(),
      selection: { provider: 'metaso', modelId, modelKey: `metaso::${modelId}`, variantSubKind: 'official' },
      imageUrl,
      options: videoOptions(modelId, { prompt: 'A captain before the window', resolution: '768P', aspectRatio: '16:9', duration: 5, generateAudio: true, ...options }),
    })
  }

  function poll(externalId: string) {
    const registration = resolveAsyncTaskProviderByExternalId(externalId)
    return registration.poll({
      parsed: registration.parseExternalId(externalId),
      context: { userId: 'test-user', getProviderConfig: async () => providerConfig(), getUserModels: async () => [] },
    })
  }

  it.each(['MiniMax-H3', 'MiniMax-H3-Max'])('submits %s text-to-video and polls to the relayed video url', async (modelId) => {
    server.defineScenario({ method: 'POST', path: CREATE, mode: 'success', submitResponse: { status: 200, body: { task_id: '2100168406192103424' } } })
    server.defineScenario({ method: 'GET', path: `${QUERY}/2100168406192103424`, mode: 'queued_then_success', pollSequence: [
      { status: 200, body: { task: { id: '2100168406192103424', status: 'queued', estimated_remaining_seconds: 40 } } },
      { status: 200, body: { task: { id: '2100168406192103424', status: 'running' } } },
      { status: 200, body: { task: { id: '2100168406192103424', status: 'succeeded', content: { url: 'https://files.metaso.cn/out.mp4?expires=1' }, usage: { total_tokens: 77 } } } },
    ] })
    const submitted = await video(modelId, {})
    expect(submitted).toMatchObject({ success: true, async: true, requestId: '2100168406192103424', externalId: 'METASO:VIDEO:2100168406192103424' })
    const [request] = server.getRequests('POST', CREATE)
    expect(request.headers.authorization).toBe('Bearer test-key')
    expect(JSON.parse(request.bodyText)).toEqual({
      model: modelId,
      content: [{ type: 'text', text: 'A captain before the window' }],
      resolution: '768P', duration: 5, ratio: '16:9', aigc_watermark: false,
    })
    expect(await poll(submitted.externalId!)).toEqual({ status: 'pending' })
    expect(await poll(submitted.externalId!)).toEqual({ status: 'pending' })
    expect(await poll(submitted.externalId!)).toEqual({
      status: 'completed', videoUrl: 'https://files.metaso.cn/out.mp4?expires=1', resultUrl: 'https://files.metaso.cn/out.mp4?expires=1', actualVideoTokens: 77,
    })
  })

  it('lets a first frame decide the ratio and keeps the single text item first', async () => {
    server.defineScenario({ method: 'POST', path: CREATE, mode: 'success', submitResponse: { status: 200, body: { task_id: '1' } } })
    await video('MiniMax-H3', { lastFrameImageUrl: 'data:image/png;base64,AAAA' }, 'https://cdn.example.com/first.png')
    const body = JSON.parse(server.getRequests('POST', CREATE)[0].bodyText)
    expect(body.ratio).toBe('adaptive')
    expect(body.content).toEqual([
      { type: 'text', text: 'A captain before the window' },
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/first.png' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, role: 'last_frame' },
    ])
  })

  it('sends multimodal references with the selected ratio', async () => {
    server.defineScenario({ method: 'POST', path: CREATE, mode: 'success', submitResponse: { status: 200, body: { task_id: '2' } } })
    await video('MiniMax-H3', { aspectRatio: '9:16', referenceVideos: ['https://cdn.example.com/ref.mp4'], referenceAudios: ['https://cdn.example.com/ref.mp3'] })
    const body = JSON.parse(server.getRequests('POST', CREATE)[0].bodyText)
    expect(body.ratio).toBe('9:16')
    expect(body.content).toEqual([
      { type: 'text', text: 'A captain before the window' },
      { type: 'video_url', video_url: { url: 'https://cdn.example.com/ref.mp4' }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: 'https://cdn.example.com/ref.mp3' }, role: 'reference_audio' },
    ])
  })

  it.each([
    ['MiniMax-H3', 'H3 has no 480P', { resolution: '480P' }],
    ['MiniMax-H3-Max', 'H3-Max has no 2K', { resolution: '2K' }],
    ['MiniMax-H3-Max', 'H3-Max starts at 5 s', { duration: 4 }],
    ['MiniMax-H3', 'audio is always generated', { generateAudio: false }],
    ['MiniMax-H3', 'adaptive is not a product ratio', { aspectRatio: 'adaptive' }],
    ['MiniMax-H3', 'reference images capped at 9', { referenceImages: Array(10).fill('https://cdn.example.com/a.png') }],
  ])('rejects options outside the %s spec (%s)', async (modelId, _label, options) => {
    await expect(video(modelId, options as Record<string, unknown>)).rejects.toMatchObject({ name: 'AiOptionValidationError' })
    expect(server.getRequests('POST', CREATE)).toHaveLength(0)
  })

  it.each([
    ['empty prompt', { prompt: '   ' }, ''],
    ['overlong prompt', { prompt: '镜'.repeat(7001) }, ''],
    ['last frame without first frame', { lastFrameImageUrl: 'https://cdn.example.com/l.png' }, ''],
    ['first frame mixed with references', { referenceImages: ['https://cdn.example.com/a.png'] }, 'https://cdn.example.com/first.png'],
  ])('rejects %s before any request is sent', async (_label, options, imageUrl) => {
    await expect(video('MiniMax-H3', options, imageUrl)).rejects.toMatchObject({ disposition: 'pre_accept_rejected', provider: 'metaso' })
    expect(server.getRequests('POST', CREATE)).toHaveLength(0)
  })

  it('classifies MiniMax 4xx envelopes as rejected submissions with the native error type', async () => {
    server.defineScenario({ method: 'POST', path: CREATE, mode: 'fatal_error',
      submitResponse: { status: 401, body: { type: 'error', error: { type: 'authorized_error', message: 'invalid api key (1004)', http_code: '401' }, request_id: 'r1' } } })
    await expect(video('MiniMax-H3', {})).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_INVALID', disposition: 'rejected', provider: 'metaso', details: { httpStatus: 401, providerCode: 'authorized_error' },
    })
  })

  it('does not treat a 5xx create response as proof of non-acceptance', async () => {
    server.defineScenario({ method: 'POST', path: CREATE, mode: 'fatal_error',
      submitResponse: { status: 503, body: { type: 'error', error: { type: 'server_error', message: 'busy' } } } })
    await expect(video('MiniMax-H3', {})).rejects.toSatisfy((error: unknown) => !('disposition' in (error as object)))
  })

  it.each(['failed', 'cancelled'])('reports a %s task as a provider failure record with the native message', async (status) => {
    server.defineScenario({ method: 'GET', path: `${QUERY}/9`, mode: 'success',
      submitResponse: { status: 200, body: { task: { id: '9', status, error: { code: '2049', message: 'content moderation blocked' } } } } })
    expect(await poll('METASO:VIDEO:9')).toMatchObject({
      status: 'failed',
      failure: {
        native: { message: 'content moderation blocked', code: '2049' },
        interpretation: { code: 'GENERATION_FAILED', details: { providerStatus: status, providerCode: '2049' } },
        context: { provider: 'metaso', phase: 'poll' },
      },
    })
  })

  it('fails closed on an unknown task status instead of guessing', async () => {
    server.defineScenario({ method: 'GET', path: `${QUERY}/10`, mode: 'success', submitResponse: { status: 200, body: { task: { id: '10', status: 'paused' } } } })
    await expect(poll('METASO:VIDEO:10')).rejects.toThrow('METASO_VIDEO_STATUS_UNKNOWN:paused')
  })

  it('prices every selectable resolution per second at the placeholder Seedance 2.5 tier', () => {
    const expected: Record<string, number> = { '480P': 14, '768P': 31, '2K': 68 }
    for (const [modelId, resolutions] of [['MiniMax-H3', ['768P', '2K']], ['MiniMax-H3-Max', ['480P', '768P']]] as const) {
      expect(modelAspectRatios(`metaso::${modelId}`, 'video')).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
      for (const resolution of resolutions) {
        expect(calcVideo(`metaso::${modelId}`, resolution, 1, { duration: 5 })).toBe(expected[resolution] * 5)
        const cost = resolveBuiltinPricing({ apiType: 'video', model: `metaso::${modelId}`, face: 'cost', selections: { resolution } })
        expect(cost.status === 'resolved' && cost.amount).toBeCloseTo(expected[resolution] / 18, 5)
      }
    }
  })
})
