import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateText, streamText } from 'ai'
import { tryResolveAiProviderAdapter } from '@/lib/ai-providers'
import { normalizeAiOptions } from '@/lib/ai-exec/normalize'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { calcImage, calcVideo } from '@/lib/billing/cost'
import { resolveAsyncTaskProviderByExternalId } from '@/lib/ai-providers'
import { resolveBuiltinPricing } from '@/lib/ai-registry/pricing-resolution'
import type { AiProviderLanguageModelContext } from '@/lib/ai-providers/runtime-types'
import { startScenarioServer } from '../../helpers/fakes/scenario-server'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
ensureAiCatalogsRegistered()

// Protocol oracle: test_api/src/openlux-*.ts plus live verification on 2026-09-14:
// edits require output_format and only accept PNG/JPEG. Keep SDK and HTTP real.
describe('OpenLux provider protocol', () => {
  let server: Awaited<ReturnType<typeof startScenarioServer>>
  beforeEach(async () => { server = await startScenarioServer() })
  afterEach(async () => { await server.close() })

  function adapter() {
    const result = tryResolveAiProviderAdapter('openlux')
    expect(result, 'OpenLux must be executable through the provider registry').not.toBeNull()
    return result!
  }

  function imageOptions(modelId: string, options: Record<string, unknown>) {
    const selection = { provider: 'openlux', modelId, modelKey: `openlux::${modelId}`, variantSubKind: 'official' as const }
    const schema = adapter().image!.describe(selection).optionSchema
    return normalizeAiOptions({ schema, options, context: 'openlux-test' })
  }

  async function image(modelId: string, options: Record<string, unknown> = {}, prompt = 'A quiet harbor') {
    return adapter().image!.execute({
      userId: 'test-user',
      providerConfig: { id: 'openlux', name: 'OpenLux', apiKey: 'test-key', baseUrl: `${server.baseUrl}/proxy/v1/` },
      selection: { provider: 'openlux', modelId, modelKey: `openlux::${modelId}`, variantSubKind: 'official' },
      prompt,
      options: imageOptions(modelId, { aspectRatio: '1:1', ...options }),
    })
  }

  function llm(modelId: string, reasoning = true) {
    const context: AiProviderLanguageModelContext = {
      providerKey: 'openlux',
      selection: { provider: 'openlux', modelId, modelKey: `openlux::${modelId}` },
      providerConfig: { id: 'openlux', name: 'OpenLux', apiKey: 'test-key', baseUrl: `${server.baseUrl}/proxy/v1/` },
      protocol: 'google-generative-ai', publicReasoningMode: 'native',
      executionMode: 'stream', reasoning, reasoningEffort: 'high',
    }
    return adapter().languageModel!.create(context)
  }

  it.each(['gpt-image-2', 'gpt-image-2-c', 'gpt-image-2.5-flare', 'gpt-image-2.5-flare-c', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-c'])(
    'generates %s with gateway format and Bearer authentication', async (modelId) => {
      server.defineScenario({ method: 'POST', path: '/proxy/v1/images/generations', mode: 'success',
        submitResponse: { status: 200, body: { data: [{ b64_json: PNG }] } } })
      expect(await image(modelId, { outputFormat: 'webp' })).toMatchObject({ success: true, imageUrl: `data:image/webp;base64,${PNG}` })
      const [request] = server.getRequests('POST', '/proxy/v1/images/generations')
      expect(request.headers.authorization).toBe('Bearer test-key')
      expect(JSON.parse(request.bodyText)).toEqual({ model: modelId, prompt: 'A quiet harbor', n: 1,
        size: '1088x1088', quality: 'high', format: 'webp', response_format: 'b64_json' })
    },
  )

  it('uploads repeated image files and preserves edit output options', async () => {
    server.defineScenario({ method: 'POST', path: '/proxy/v1/images/edits', mode: 'success',
      submitResponse: { status: 200, body: { data: [{ url: 'https://cdn.example.com/result.webp' }] } } })
    expect(await image('gpt-image-2.5-flare', { quality: 'max', outputFormat: 'jpeg', background: 'opaque',
      referenceImages: [`data:image/png;base64,${PNG}`, `data:image/png;base64,${PNG}`] })).toMatchObject({ imageUrl: 'https://cdn.example.com/result.webp' })
    const [request] = server.getRequests('POST', '/proxy/v1/images/edits')
    const form = await new Response(new Uint8Array(request.bodyBuffer), { headers: { 'content-type': String(request.headers['content-type']) } }).formData()
    expect(form.getAll('image')).toHaveLength(2)
    expect(await (form.get('image') as File).arrayBuffer()).toEqual(Uint8Array.from(Buffer.from(PNG, 'base64')).buffer)
    expect(form.get('output_format')).toBe('jpeg')
    expect(form.get('quality')).toBe('max')
    expect(form.get('background')).toBe('opaque')
    expect(form.get('format')).toBeNull()
  })

  it.each([
    ['gpt-image-2', { quality: 'max' }],
    ['gpt-image-2.5-flare', { outputFormat: 'jpeg', background: 'transparent' }],
    ['gpt-image-2.5-flare', { referenceImages: Array(17).fill('https://example.com/image.png') }],
    ['gpt-image-2.5-flare', { outputFormat: 'webp', referenceImages: [`data:image/png;base64,${PNG}`] }],
  ])('rejects unsupported image options before submission (%s)', async (modelId, options) => {
    await expect(image(modelId as string, options as Record<string, unknown>)).rejects.toMatchObject({ name: 'AiOptionValidationError' })
    expect(server.getRequests('POST', '/proxy/v1/images/generations')).toHaveLength(0)
  })

  it('rejects overlong prompts before submission', async () => {
    await expect(image('gpt-image-2.5-flare', {}, '画'.repeat(1001))).rejects.toMatchObject({ disposition: 'pre_accept_rejected' })
  })

  it('covers every selectable image tier with the temporary OpenRouter price', () => {
    const ratios = { '1:1': '1024x1024', '4:3': '1024x768', '3:4': '1024x768', '3:2': '1024x1536', '2:3': '1024x1536', '16:9': '1920x1080', '9:16': '1024x1536' }
    for (const modelId of ['gpt-image-2', 'gpt-image-2-c', 'gpt-image-2.5-flare', 'gpt-image-2.5-flare-c', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-c']) {
      for (const resolution of ['1K', '2K', '4K']) {
        for (const [aspectRatio, imageSize] of Object.entries(ratios)) {
          for (const quality of modelId.startsWith('gpt-image-2.5') ? ['low', 'medium', 'high', 'auto', 'xhigh', 'max'] : ['low', 'medium', 'high', 'auto']) {
            expect(calcImage(`openlux::${modelId}`, 1, { resolution, aspectRatio, quality })).toBe(
              calcImage('openrouter::openai/gpt-image-2', 1, { imageSize, quality: ['auto', 'xhigh', 'max'].includes(quality) ? 'high' : quality }),
            )
          }
        }
      }
    }
  })

  it.each([['gemini-2.5-pro', 9, 72], ['gemini-2.5-flash', 2.16, 18], ['gemini-3-flash-preview', 3.6, 21.6], ['gemini-3.8-flash', 5.4, 27], ['gemini-3-pro-preview', 14.4, 86.4],
    ['gpt-5.6-luna', 1.44, 8.64], ['gpt-5.6-terra', 14.4, 86.4], ['gpt-5.6-sol', 14.4, 72], ['gpt-6-astra', 72, 360]])(
    'uses reference token prices for %s', (modelId, input, output) => {
      for (const [tokenType, amount] of [['input', input], ['output', output]] as const) {
        const price = resolveBuiltinPricing({ apiType: 'text', model: `openlux::${modelId}`, face: 'cost', selections: { tokenType } })
        expect(price).toMatchObject({ status: 'resolved' })
        if (price.status === 'resolved') expect(price.amount).toBeCloseTo(Number(amount))
      }
    },
  )

  it('retains provider identity and rejection disposition on authentication errors', async () => {
    server.defineScenario({ method: 'POST', path: '/proxy/v1/images/generations', mode: 'fatal_error',
      submitResponse: { status: 401, body: { error: { message: 'Invalid API key' } } } })
    await expect(image('gpt-image-2')).rejects.toMatchObject({ provider: 'openlux', disposition: 'rejected' })
  })

  it('rejects successful HTTP responses without image output', async () => {
    server.defineScenario({ method: 'POST', path: '/proxy/v1/images/generations', mode: 'success',
      submitResponse: { status: 200, body: { data: [] } } })
    await expect(image('gpt-image-2')).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it.each([
    { data: [{ b64_json: `data:image/png;base64,${PNG}` }] },
    { choices: [{ message: { content: `![result](data:image/png;base64,${PNG})` } }] },
  ])('normalizes gateway data URL image responses and preserves MIME', async (body) => {
    server.defineScenario({ method: 'POST', path: '/proxy/v1/images/generations', mode: 'success', submitResponse: { status: 200, body } })
    expect(await image('gpt-image-2', { outputFormat: 'webp' })).toMatchObject({ imageUrl: `data:image/png;base64,${PNG}`, imageBase64: PNG })
  })

  it('diagnoses a gateway configured with its native Gemini base URL', async () => {
    server.defineScenario({ method: 'GET', path: '/proxy/v1/models', mode: 'success',
      submitResponse: { status: 200, body: { data: [{ id: 'gemini-3.8-flash' }] } } })
    server.defineScenario({ method: 'POST', path: '/proxy/v1beta/models/gemini-3.8-flash:generateContent', mode: 'success',
      submitResponse: { status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text: '2' }] }, finishReason: 'STOP', index: 0 }] } } })
    expect(await adapter().connectionTest!.diagnose({ apiKey: 'test-key', baseUrl: `${server.baseUrl}/proxy/v1beta/models/` })).toMatchObject({ success: true })
  })

  it.each(['gemini-3.8-flash', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'])(
    'streams native Gemini text, thoughts and usage for %s', async (modelId) => {
      const path = `/proxy/v1beta/models/${modelId}:streamGenerateContent`
      const chunk = { candidates: [{ content: { role: 'model', parts: [{ text: 'Thinking', thought: true }, { text: 'Hello' }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 9 } }
      server.defineScenario({ method: 'POST', path, mode: 'success', submitResponse: {
        status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify(chunk)}\n\n` } })
      const result = streamText({ model: llm(modelId), prompt: 'Hello', maxRetries: 0 })
      expect(await result.text).toBe('Hello')
      expect(await result.reasoningText).toBe('Thinking')
      expect((await result.usage).inputTokens).toBe(4)
      const [request] = server.getRequests('POST', path)
      expect(request.headers.authorization).toBe('Bearer test-key')
      expect(request.headers['x-goog-api-key']).toBeUndefined()
      expect(request.query).toBe('?alt=sse')
      const body = JSON.parse(request.bodyText)
      expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }])
      expect(body.generationConfig.thinkingConfig).toEqual(modelId.startsWith('gemini-3')
        ? { thinkingLevel: 'high', includeThoughts: true }
        : { thinkingBudget: modelId === 'gemini-2.5-flash' ? 24576 : 32768, includeThoughts: true })
    },
  )

  function gptLlm(modelId: string) {
    const context: AiProviderLanguageModelContext = {
      providerKey: 'openlux',
      selection: { provider: 'openlux', modelId, modelKey: `openlux::${modelId}` },
      providerConfig: { id: 'openlux', name: 'OpenLux', apiKey: 'test-key', baseUrl: `${server.baseUrl}/proxy/v1/` },
      protocol: 'openai-responses', publicReasoningMode: 'summary_auto',
      executionMode: 'sync', reasoning: true, reasoningEffort: 'medium',
    }
    return adapter().languageModel!.create(context)
  }

  function responsesBody(modelId: string, text: string) {
    return { id: `resp_${modelId}`, object: 'response', status: 'completed', model: modelId, created_at: 1789407088,
      output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }
  }

  // Protocol oracle: live /v1/responses probes on 2026-09-15 (standard Responses
  // events, function_call items, encrypted reasoning on GPT-5.6; Gemini rejected).
  it.each(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra'])(
    'sends %s through the OpenAI Responses wire with Bearer authentication', async (modelId) => {
      server.defineScenario({ method: 'POST', path: '/proxy/v1/responses', mode: 'success',
        submitResponse: { status: 200, body: responsesBody(modelId, 'Hello') } })
      const result = await generateText({ model: gptLlm(modelId), prompt: 'Hi', maxRetries: 0 })
      expect(result.text).toBe('Hello')
      const [request] = server.getRequests('POST', '/proxy/v1/responses')
      expect(request.headers.authorization).toBe('Bearer test-key')
      const body = JSON.parse(request.bodyText)
      expect(body.model).toBe(modelId)
      expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
      expect(body.store).toBe(false)
    },
  )

  it('tests a GPT model connection on the Responses wire, not the Gemini wire', async () => {
    server.defineScenario({ method: 'POST', path: '/proxy/v1/responses', mode: 'success',
      submitResponse: { status: 200, body: responsesBody('gpt-5.6-luna', '2') } })
    expect(await adapter().connectionTest!.testLlm!({ apiKey: 'test-key', baseUrl: `${server.baseUrl}/proxy/v1/`, model: 'gpt-5.6-luna' }))
      .toMatchObject({ answer: '2' })
    expect(server.getRequests('POST', '/proxy/v1/responses')).toHaveLength(1)
  })

  it('supports nonstreaming Gemini calls and inline vision input', async () => {
    const path = '/proxy/v1beta/models/gemini-3-pro-preview:generateContent'
    server.defineScenario({ method: 'POST', path, mode: 'success', submitResponse: { status: 200,
      body: { candidates: [{ content: { role: 'model', parts: [{ text: 'A harbor' }] }, finishReason: 'STOP', index: 0 }] } } })
    const result = await generateText({ model: llm('gemini-3-pro-preview', false), maxRetries: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image', image: `data:image/png;base64,${PNG}` }] }] })
    expect(result.text).toBe('A harbor')
    expect(JSON.parse(server.getRequests('POST', path)[0].bodyText).contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG } })
  })

  // Protocol oracle: test_api/src/openlux-seedance2.ts, live 2026-09-16 — Ark
  // passthrough at /api/v3, numeric task id, pending -> running -> succeeded,
  // audio track present even when generate_audio is false.
  function videoOptions(modelId: string, options: Record<string, unknown>) {
    const selection = { provider: 'openlux', modelId, modelKey: `openlux::${modelId}`, variantSubKind: 'official' as const }
    const schema = adapter().video!.describe(selection).optionSchema
    return normalizeAiOptions({ schema, options, context: 'openlux-video-test' })
  }

  async function video(modelId: string, options: Record<string, unknown>, imageUrl = '') {
    return adapter().video!.execute({
      userId: 'test-user',
      providerConfig: { id: 'openlux', name: 'OpenLux', apiKey: 'test-key', baseUrl: `${server.baseUrl}/proxy/v1/` },
      selection: { provider: 'openlux', modelId, modelKey: `openlux::${modelId}`, variantSubKind: 'official' },
      imageUrl,
      options: videoOptions(modelId, { prompt: 'A harbor at dusk', resolution: '720p', aspectRatio: '16:9', duration: 5, generateAudio: true, ...options }),
    })
  }

  function pollVideo(externalId: string) {
    return resolveAsyncTaskProviderByExternalId(externalId).poll({
      parsed: resolveAsyncTaskProviderByExternalId(externalId).parseExternalId(externalId),
      context: {
        userId: 'test-user',
        getProviderConfig: async () => ({ id: 'openlux', name: 'OpenLux', apiKey: 'test-key', baseUrl: `${server.baseUrl}/proxy/v1/` }),
        getUserModels: async () => [],
      },
    })
  }

  it.each(['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128'])(
    'submits %s through the Ark passthrough and polls to the gateway video url', async (modelId) => {
      server.defineScenario({ method: 'POST', path: '/proxy/api/v3/contents/generations/tasks', mode: 'success',
        submitResponse: { status: 200, body: { id: '139513828' } } })
      server.defineScenario({ method: 'GET', path: '/proxy/api/v3/contents/generations/tasks/139513828', mode: 'queued_then_success',
        pollSequence: [
          { status: 200, body: { id: '139513828', status: 'pending' } },
          { status: 200, body: { id: '139513828', status: 'running' } },
          { status: 200, body: { id: '139513828', status: 'succeeded', content: { video_url: 'https://tos.example/out.mp4' }, usage: { total_tokens: 123 } } },
        ] })
      const submitted = await video(modelId, {}, 'https://cdn.example.com/first.png')
      expect(submitted).toMatchObject({ success: true, async: true, requestId: '139513828', externalId: 'OPENLUX:VIDEO:139513828' })
      const [request] = server.getRequests('POST', '/proxy/api/v3/contents/generations/tasks')
      expect(request.headers.authorization).toBe('Bearer test-key')
      expect(JSON.parse(request.bodyText)).toEqual({
        model: modelId,
        content: [
          { type: 'text', text: 'A harbor at dusk' },
          { type: 'image_url', image_url: { url: 'https://cdn.example.com/first.png' }, role: 'first_frame' },
        ],
        resolution: '720p', ratio: '16:9', duration: 5, generate_audio: true, watermark: false,
      })
      expect(await pollVideo(submitted.externalId!)).toEqual({ status: 'pending' })
      expect(await pollVideo(submitted.externalId!)).toEqual({ status: 'pending' })
      expect(await pollVideo(submitted.externalId!)).toEqual({
        status: 'completed', videoUrl: 'https://tos.example/out.mp4', resultUrl: 'https://tos.example/out.mp4', actualVideoTokens: 123,
      })
    },
  )

  it('maps reference roles in Ark order and keeps text first', async () => {
    server.defineScenario({ method: 'POST', path: '/proxy/api/v3/contents/generations/tasks', mode: 'success',
      submitResponse: { status: 200, body: { id: '7' } } })
    await video('doubao-seedance-2-0-260128', {
      referenceImages: ['https://cdn.example.com/a.png'], referenceAudios: ['https://cdn.example.com/a.mp3'], referenceVideos: ['https://cdn.example.com/a.mp4'],
    })
    expect(JSON.parse(server.getRequests('POST', '/proxy/api/v3/contents/generations/tasks')[0].bodyText).content).toEqual([
      { type: 'text', text: 'A harbor at dusk' },
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' }, role: 'reference_image' },
      { type: 'audio_url', audio_url: { url: 'https://cdn.example.com/a.mp3' }, role: 'reference_audio' },
      { type: 'video_url', video_url: { url: 'https://cdn.example.com/a.mp4' }, role: 'reference_video' },
    ])
  })

  it.each([
    ['generateAudio false is not honoured by the gateway', { generateAudio: false }],
    ['1080p has no cost tier on this route', { resolution: '1080p' }],
    ['reference audio needs a visual reference', { referenceAudios: ['https://cdn.example.com/a.mp3'] }],
    ['last frame conflicts with references', { lastFrameImageUrl: 'https://cdn.example.com/l.png', referenceImages: ['https://cdn.example.com/a.png'] }],
  ])('rejects video options the model does not support (%s)', async (_label, options) => {
    await expect(video('doubao-seedance-2-0-fast-260128', options as Record<string, unknown>)).rejects.toMatchObject({ name: 'AiOptionValidationError' })
    expect(server.getRequests('POST', '/proxy/api/v3/contents/generations/tasks')).toHaveLength(0)
  })

  it('rejects a last frame without a first frame before submission', async () => {
    await expect(video('doubao-seedance-2-0-260128', { lastFrameImageUrl: 'https://cdn.example.com/l.png' }))
      .rejects.toMatchObject({ disposition: 'pre_accept_rejected', provider: 'openlux' })
  })

  it('surfaces a rejected video submission with the gateway status', async () => {
    server.defineScenario({ method: 'POST', path: '/proxy/api/v3/contents/generations/tasks', mode: 'fatal_error',
      submitResponse: { status: 400, body: { error: { code: 'InvalidParameter', message: 'duration out of range' } } } })
    await expect(video('doubao-seedance-2-0-260128', {})).rejects.toMatchObject({
      code: 'PROVIDER_SUBMISSION_REJECTED', disposition: 'rejected', provider: 'openlux', details: { httpStatus: 400 },
    })
  })

  it.each(['failed', 'expired'])('reports a %s task as a provider failure record', async (status) => {
    server.defineScenario({ method: 'GET', path: '/proxy/api/v3/contents/generations/tasks/9', mode: 'success',
      submitResponse: { status: 200, body: { id: '9', status, error: { code: 'OutputVideoSensitiveContentDetected', message: 'sensitive content' } } } })
    expect(await pollVideo('OPENLUX:VIDEO:9')).toMatchObject({
      status: 'failed',
      failure: {
        native: { message: 'sensitive content', code: 'OutputVideoSensitiveContentDetected' },
        interpretation: { code: 'GENERATION_FAILED', details: { providerStatus: status, providerCode: 'OutputVideoSensitiveContentDetected' } },
        context: { provider: 'openlux', phase: 'poll' },
      },
    })
  })

  it('bills Seedance on OpenLux at the shared Seedance product rate', () => {
    for (const [modelId, arkModelId] of [['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-260128'], ['doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-fast-260128']]) {
      for (const resolution of ['480p', '720p']) {
        expect(calcVideo(`openlux::${modelId}`, resolution, 1, { duration: 5 })).toBe(calcVideo(`ark::${arkModelId}`, resolution, 1, { duration: 5 }))
      }
    }
  })
})
