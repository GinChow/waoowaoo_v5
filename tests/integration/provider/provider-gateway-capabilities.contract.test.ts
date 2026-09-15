import {
  arkAdapter,
  beforeEach,
  buildOpenRouterSessionId,
  chatCompletionResponse,
  describe,
  ensureAiCatalogsRegistered,
  expect,
  fetchMock,
  googleAdapter,
  it,
  normalizeOpenRouterSessionId,
  openRouterAdapter,
  jsonResponse,
  responsesApiResponse,
  responsesApiStream,
  vi,
} from './provider-gateway-dispatch.fixture'
import { ARK_PROVIDER_TEST_LLM_MODEL_ID } from '@/lib/ai-providers/ark/llm-models'
import { generateText, streamText } from 'ai'
import { listBuiltinCapabilityCatalog } from '@/lib/ai-registry/capabilities-catalog'
import {
  OPENROUTER_CLAUDE_FABLE_5_MODEL_ID,
  OPENROUTER_CLAUDE_SONNET_5_MODEL_ID,
  OPENROUTER_GPT_IMAGE_2_MODEL_ID,
  OPENROUTER_GPT_5_6_LUNA_MODEL_ID,
  OPENROUTER_GPT_5_6_REASONING_EFFORT_OPTIONS,
  OPENROUTER_GPT_5_6_SOL_MODEL_ID,
  OPENROUTER_GPT_5_6_TERRA_MODEL_ID,
  OPENROUTER_LLM_MODEL_DEFINITIONS,
} from '@/lib/ai-providers/openrouter/models'
import {
  FAL_GPT_IMAGE_2_MODEL_ID,
  resolveFalOptionSchema,
} from '@/lib/ai-providers/fal/models'
import { describeLlmVariantBase } from '@/lib/ai-exec/llm-descriptor'
import { AiOptionValidationError, normalizeAiOptions } from '@/lib/ai-exec/normalize'
import { createAiLanguageModel } from '@/lib/ai-exec/language-model'
import { listApiConfigCatalogModels } from '@/lib/ai-registry/api-config-catalog'
import {
  resolveRegisteredLlmProtocol,
  resolveRegisteredPublicReasoningMode,
} from '@/lib/ai-registry/llm-protocol'
import { resolveProviderRouteSet } from '@/lib/ai-registry/provider-route-set'
import { listBuiltinPricingCatalog } from '@/lib/ai-registry/pricing-catalog'
import {
  listPlatformCatalogModels,
} from '@/lib/platform-models/catalog'

async function requestBodyOf(call: [RequestInfo | URL, RequestInit?]): Promise<Record<string, unknown>> {
  const [input, init] = call
  const bodyText = typeof init?.body === 'string'
    ? init.body
    : input instanceof Request
      ? await input.clone().text()
      : ''
  return JSON.parse(bodyText) as Record<string, unknown>
}

describe('provider contract - gateway dispatch (connection tests, session, capabilities)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureAiCatalogsRegistered()
  })

  it('normalizes FAL GPT Image 2 options from its production schema', () => {
    const schema = resolveFalOptionSchema('image', FAL_GPT_IMAGE_2_MODEL_ID)
    expect(normalizeAiOptions({
      schema,
      options: { aspectRatio: '4:3', size: '2K', quality: 'medium' },
      context: 'fal-gpt-image-2',
    })).toMatchObject({
      aspectRatio: '4:3',
      resolution: '2K',
      quality: 'medium',
      outputFormat: 'png',
      referenceImages: [],
      imageSize: { width: 1920, height: 1440 },
    })
    expect(() => normalizeAiOptions({
      schema,
      options: { aspectRatio: '1:1', quality: 'auto' },
      context: 'fal-gpt-image-2',
    })).toThrow(AiOptionValidationError)
  })

  it('keeps every production model on its explicitly selected provider', () => {
    expect(resolveProviderRouteSet('image', `openrouter::${OPENROUTER_GPT_IMAGE_2_MODEL_ID}`)).toEqual({
      logicalCapabilityId: `image:openrouter::${OPENROUTER_GPT_IMAGE_2_MODEL_ID}`,
      primaryModelKey: `openrouter::${OPENROUTER_GPT_IMAGE_2_MODEL_ID}`,
      failoverPolicy: 'pre_accept_only',
      routes: [
        {
          provider: 'openrouter',
          modelId: OPENROUTER_GPT_IMAGE_2_MODEL_ID,
          modelKey: `openrouter::${OPENROUTER_GPT_IMAGE_2_MODEL_ID}`,
          priority: 0,
        },
      ],
    })
    expect(resolveProviderRouteSet('image', `fal::${FAL_GPT_IMAGE_2_MODEL_ID}`).routes).toEqual([
      {
        provider: 'fal',
        modelId: FAL_GPT_IMAGE_2_MODEL_ID,
        modelKey: `fal::${FAL_GPT_IMAGE_2_MODEL_ID}`,
        priority: 0,
      },
    ])
    expect(listBuiltinCapabilityCatalog().every((entry) => entry.providerRoute === undefined)).toBe(true)
  })

  it('registers one explicit transport protocol for every configured LLM model', () => {
    // OpenLux serves Gemini natively and OpenAI-series models through /v1/responses.
    const expectedProtocol = (provider: string, modelId: string) => {
      switch (provider) {
        case 'ark': return 'openai-responses'
        case 'google': return 'google-generative-ai'
        case 'openlux': return modelId.startsWith('gpt-') ? 'openai-responses' : 'google-generative-ai'
        case 'openrouter': return 'openrouter-chat'
        default: return null
      }
    }
    const llmModels = listApiConfigCatalogModels().filter((model) => model.type === 'llm')
    expect(llmModels.length).toBeGreaterThan(0)
    const openLuxGpt = llmModels.filter((model) => model.provider === 'openlux' && model.modelId.startsWith('gpt-'))
    expect(openLuxGpt.map((model) => model.modelId).sort())
      .toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra'])
    for (const model of llmModels) {
      const expected = expectedProtocol(model.provider, model.modelId)
      expect(expected).toBeTruthy()
      expect(resolveRegisteredLlmProtocol(`${model.provider}::${model.modelId}`)).toBe(expected)
    }
  })

  it('derives every OpenRouter LLM catalog surface from one provider definition', () => {
    const capabilities = new Set(listBuiltinCapabilityCatalog()
      .filter((entry) => entry.provider === 'openrouter' && entry.modelType === 'llm')
      .map((entry) => entry.modelId))
    const pricing = new Set(listBuiltinPricingCatalog()
      .filter((entry) => entry.provider === 'openrouter' && entry.apiType === 'text')
      .map((entry) => entry.modelId))
    const apiConfig = new Set(listApiConfigCatalogModels()
      .filter((model) => model.provider === 'openrouter' && model.type === 'llm')
      .map((model) => model.modelId))
    const platform = new Set(listPlatformCatalogModels()
      .filter((model) => model.provider === 'openrouter' && model.type === 'llm')
      .map((model) => model.modelId))

    for (const model of OPENROUTER_LLM_MODEL_DEFINITIONS) {
      expect(capabilities.has(model.modelId)).toBe(true)
      expect(pricing.has(model.modelId)).toBe(model.pricingUsdPerMillion !== null)
      expect(apiConfig.has(model.modelId)).toBe(model.showInApiConfig)
      expect(platform.has(model.modelId)).toBe(model.showInPlatform)
    }
  })

  it('derives public reasoning behavior from the production model registry', () => {
    expect(resolveRegisteredPublicReasoningMode(
      `openrouter::${OPENROUTER_GPT_5_6_TERRA_MODEL_ID}`,
    )).toBe('summary_auto')
    expect(resolveRegisteredPublicReasoningMode('openrouter::anthropic/claude-sonnet-4.5'))
      .toBe('native')
    expect(resolveRegisteredPublicReasoningMode(
      `openrouter::${OPENROUTER_CLAUDE_FABLE_5_MODEL_ID}`,
    )).toBe('native')
    expect(resolveRegisteredPublicReasoningMode('google::gemini-3.5-flash'))
      .toBe('native')
  })

  describe('provider-owned AI SDK wire options remain exact', () => {
    it('injects Ark thinking into the Responses request without a handwritten transport', async () => {
      fetchMock.mockResolvedValueOnce(responsesApiResponse(ARK_PROVIDER_TEST_LLM_MODEL_ID, 'ok'))
      const model = createAiLanguageModel({
        providerKey: 'ark',
        selection: {
          provider: 'ark',
          modelId: ARK_PROVIDER_TEST_LLM_MODEL_ID,
          modelKey: `ark::${ARK_PROVIDER_TEST_LLM_MODEL_ID}`,
        },
        providerConfig: {
          id: 'ark',
          name: 'Ark',
          apiKey: 'test-key',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        },
        executionMode: 'sync',
        reasoning: true,
        reasoningEffort: 'medium',
      })

      await generateText({ model, prompt: 'hello', maxRetries: 0 })

      const body = await requestBodyOf(fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?])
      expect(body.thinking).toEqual({ type: 'enabled' })
    })

    it('lets the OpenAI Responses SDK parse Ark reasoning and text SSE events', async () => {
      fetchMock.mockResolvedValueOnce(responsesApiStream([
        {
          type: 'response.created',
          response: {
            id: 'resp-ark-stream',
            created_at: 1,
            model: ARK_PROVIDER_TEST_LLM_MODEL_ID,
            service_tier: null,
          },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-1' },
        },
        {
          type: 'response.reasoning_summary_part.added',
          item_id: 'reasoning-1',
          summary_index: 0,
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'reasoning-1',
          summary_index: 0,
          delta: 'think',
        },
        {
          type: 'response.reasoning_summary_part.done',
          item_id: 'reasoning-1',
          summary_index: 0,
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'reasoning', id: 'reasoning-1' },
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'message', id: 'message-1' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'message-1',
          delta: 'answer',
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { type: 'message', id: 'message-1' },
        },
        {
          type: 'response.completed',
          response: {
            incomplete_details: null,
            service_tier: null,
            usage: {
              input_tokens: 8,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 5,
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        },
      ]))
      const model = createAiLanguageModel({
        providerKey: 'ark',
        selection: {
          provider: 'ark',
          modelId: ARK_PROVIDER_TEST_LLM_MODEL_ID,
          modelKey: `ark::${ARK_PROVIDER_TEST_LLM_MODEL_ID}`,
        },
        providerConfig: {
          id: 'ark',
          name: 'Ark',
          apiKey: 'test-key',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        },
        executionMode: 'stream',
        reasoning: true,
        reasoningEffort: 'medium',
      })
      const stream = streamText({ model, prompt: 'hello', maxRetries: 0 })
      let text = ''
      let reasoning = ''
      for await (const chunk of stream.fullStream) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      }

      expect(text).toBe('answer')
      expect(reasoning).toBe('think')
      expect(await stream.text).toBe('answer')
      expect(await stream.reasoningText).toBe('think')
    })

    it('encodes Ark and Google vision images through their native AI SDK protocols', async () => {
      fetchMock
        .mockResolvedValueOnce(responsesApiResponse(ARK_PROVIDER_TEST_LLM_MODEL_ID, 'ark vision ok'))
        .mockResolvedValueOnce(jsonResponse({
          responseId: 'google-vision-response',
          modelVersion: 'gemini-3.1-pro-preview',
          candidates: [{
            content: { role: 'model', parts: [{ text: 'google vision ok' }] },
            finishReason: 'STOP',
            safetyRatings: [],
          }],
          usageMetadata: {
            promptTokenCount: 8,
            candidatesTokenCount: 3,
            totalTokenCount: 11,
          },
        }))

      const image = 'data:image/png;base64,aGVsbG8='
      const visionMessages = [{
        role: 'user' as const,
        content: [
          { type: 'image' as const, image },
          { type: 'text' as const, text: 'describe' },
        ],
      }]
      const providerConfig = {
        id: 'test-provider',
        name: 'Test Provider',
        apiKey: 'test-key',
      }
      const arkModel = createAiLanguageModel({
        providerKey: 'ark',
        selection: {
          provider: 'ark',
          modelId: ARK_PROVIDER_TEST_LLM_MODEL_ID,
          modelKey: `ark::${ARK_PROVIDER_TEST_LLM_MODEL_ID}`,
        },
        providerConfig: {
          ...providerConfig,
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        },
        executionMode: 'vision',
        reasoning: false,
        reasoningEffort: 'medium',
      })
      const googleModel = createAiLanguageModel({
        providerKey: 'google',
        selection: {
          provider: 'google',
          modelId: 'gemini-3.1-pro-preview',
          modelKey: 'google::gemini-3.1-pro-preview',
        },
        providerConfig: {
          ...providerConfig,
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        },
        executionMode: 'vision',
        reasoning: false,
        reasoningEffort: 'medium',
      })

      await generateText({ model: arkModel, messages: visionMessages, maxRetries: 0 })
      await generateText({ model: googleModel, messages: visionMessages, maxRetries: 0 })

      const arkBody = await requestBodyOf(fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?])
      expect(arkBody.input).toEqual([{
        role: 'user',
        content: [
          { type: 'input_image', image_url: image },
          { type: 'input_text', text: 'describe' },
        ],
      }])
      const googleBody = await requestBodyOf(fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?])
      expect(googleBody.contents).toEqual([{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
          { text: 'describe' },
        ],
      }])
    })

    it('preserves OpenRouter cache breakpoints and session identity on the SDK request', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        id: 'openrouter-response',
        model: 'anthropic/claude-sonnet-4.6',
        provider: 'Anthropic',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'ok', reasoning: 'think' },
        }],
        usage: {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 },
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 8 },
          total_tokens: 120,
          cost: 0.25,
        },
      }))
      const sourceMessages = [{
        role: 'user' as const,
        content: [{
          type: 'text' as const,
          text: 'cached instructions',
          cacheControl: { type: 'ephemeral' as const, ttl: '1h' as const },
        }],
      }]
      const model = createAiLanguageModel({
        providerKey: 'openrouter',
        selection: {
          provider: 'openrouter',
          modelId: 'anthropic/claude-sonnet-4.6',
          modelKey: 'openrouter::anthropic/claude-sonnet-4.6',
        },
        providerConfig: {
          id: 'openrouter',
          name: 'OpenRouter',
          apiKey: 'test-key',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        executionMode: 'sync',
        reasoning: false,
        reasoningEffort: 'medium',
        messages: sourceMessages,
        openRouterSessionId: 'project-session',
      })

      const result = await generateText({ model, prompt: 'cached instructions', maxRetries: 0 })

      const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?]
      const body = await requestBodyOf(call)
      expect(body.cache_control).toBeUndefined()
      expect(body.messages).toEqual([{
        role: 'user',
        content: [{
          type: 'text',
          text: 'cached instructions',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
      }])
      const headers = new Headers(call[1]?.headers)
      expect(headers.get('x-session-id')).toBe('project-session')
      expect(result.text).toBe('ok')
      expect(result.reasoningText).toBe('think')
      expect(result.usage.inputTokenDetails).toMatchObject({
        cacheReadTokens: 40,
        cacheWriteTokens: 5,
      })
      expect(result.providerMetadata?.openrouter?.usage).toMatchObject({ cost: 0.25 })
    })

    it('keeps Claude one-shot sync caching on the 5m default', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        id: 'openrouter-sync-response',
        model: OPENROUTER_CLAUDE_SONNET_5_MODEL_ID,
        provider: 'Anthropic',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'ok' },
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 2,
          total_tokens: 102,
          cost: 0.01,
        },
      }))
      const model = createAiLanguageModel({
        providerKey: 'openrouter',
        selection: {
          provider: 'openrouter',
          modelId: OPENROUTER_CLAUDE_SONNET_5_MODEL_ID,
          modelKey: `openrouter::${OPENROUTER_CLAUDE_SONNET_5_MODEL_ID}`,
        },
        providerConfig: {
          id: 'openrouter',
          name: 'OpenRouter',
          apiKey: 'test-key',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        executionMode: 'sync',
        reasoning: false,
        reasoningEffort: 'medium',
      })
      await generateText({
        model,
        messages: [{ role: 'user' as const, content: 'one shot' }],
        maxRetries: 0,
      })

      const body = await requestBodyOf(fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?])
      // Claude's provider-owned automatic cache uses its default ephemeral TTL.
      expect(body.cache_control).toEqual({ type: 'ephemeral' })
    })

    it('passes Google thinking configuration through the Google AI SDK', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        responseId: 'google-response',
        modelVersion: 'gemini-3.1-pro-preview',
        candidates: [{
          content: {
            role: 'model',
            parts: [{ text: 'think', thought: true }, { text: 'ok' }],
          },
          finishReason: 'STOP',
          safetyRatings: [],
        }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          totalTokenCount: 12,
          cachedContentTokenCount: 4,
        },
      }))
      const model = createAiLanguageModel({
        providerKey: 'google',
        selection: {
          provider: 'google',
          modelId: 'gemini-3.1-pro-preview',
          modelKey: 'google::gemini-3.1-pro-preview',
        },
        providerConfig: {
          id: 'google',
          name: 'Google',
          apiKey: 'test-key',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        },
        executionMode: 'sync',
        reasoning: true,
        reasoningEffort: 'high',
      })

      const result = await generateText({ model, prompt: 'hello', maxRetries: 0 })

      const body = await requestBodyOf(fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?])
      expect(body.generationConfig).toMatchObject({
        thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
      })
      expect(result.reasoningText).toBe('think')
      expect(result.text).toBe('ok')
      expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(4)
    })
  })

  describe('GPT-5.6 reasoning effort is registry-owned and exact on the wire', () => {
    it('registers Luna, Terra, and Sol with their complete OpenRouter effort set', () => {
      const catalog = listBuiltinCapabilityCatalog()

      for (const modelId of [
        OPENROUTER_GPT_5_6_LUNA_MODEL_ID,
        OPENROUTER_GPT_5_6_TERRA_MODEL_ID,
        OPENROUTER_GPT_5_6_SOL_MODEL_ID,
      ]) {
        const entry = catalog.find((candidate) => (
          candidate.modelType === 'llm'
          && candidate.provider === 'openrouter'
          && candidate.modelId === modelId
        ))
        expect(entry?.capabilities?.llm?.reasoningEffortOptions)
          .toEqual([...OPENROUTER_GPT_5_6_REASONING_EFFORT_OPTIONS])
      }
    })

    it('accepts max and rejects unsupported minimal before provider execution', () => {
      const selection = {
        provider: 'openrouter',
        modelId: OPENROUTER_GPT_5_6_LUNA_MODEL_ID,
        modelKey: `openrouter::${OPENROUTER_GPT_5_6_LUNA_MODEL_ID}`,
        variantSubKind: 'official' as const,
      }
      const schema = describeLlmVariantBase({
        modality: 'llm',
        selection,
        executionMode: 'sync',
      }).optionSchema

      expect(() => normalizeAiOptions({ schema, options: { reasoningEffort: 'max' }, context: 'test' }))
        .not.toThrow()
      expect(() => normalizeAiOptions({ schema, options: { reasoningEffort: 'minimal' }, context: 'test' }))
        .toThrow(AiOptionValidationError)
    })

    it('preserves max in OpenRouter text and vision request bodies', async () => {
      fetchMock.mockImplementation(async () => (
        chatCompletionResponse(OPENROUTER_GPT_5_6_LUNA_MODEL_ID, 'ok')
      ))
      const selection = {
        provider: 'openrouter',
        modelId: OPENROUTER_GPT_5_6_LUNA_MODEL_ID,
        modelKey: `openrouter::${OPENROUTER_GPT_5_6_LUNA_MODEL_ID}`,
        variantSubKind: 'official' as const,
      }
      const providerConfig = {
        id: 'openrouter',
        name: 'OpenRouter',
        apiKey: 'test-key',
        baseUrl: 'https://openrouter.ai/api/v1',
      }
      const textModel = createAiLanguageModel({
        providerKey: 'openrouter',
        selection,
        providerConfig,
        executionMode: 'sync',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: true,
        reasoningEffort: 'max',
      })
      await generateText({ model: textModel, prompt: 'hello', maxRetries: 0 })
      const textBody = await requestBodyOf(fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?])
      expect(textBody.reasoning).toEqual({ effort: 'max', summary: 'auto' })

      const visionModel = createAiLanguageModel({
        providerKey: 'openrouter',
        selection,
        providerConfig,
        executionMode: 'vision',
        messages: [{ role: 'user', content: 'describe' }],
        reasoning: true,
        reasoningEffort: 'max',
      })
      await generateText({
        model: visionModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', image: 'data:image/png;base64,aGVsbG8=' },
            { type: 'text', text: 'describe' },
          ],
        }],
        maxRetries: 0,
      })
      const visionBody = await requestBodyOf(fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?])
      expect(visionBody.reasoning).toEqual({ effort: 'max', summary: 'auto' })
    })

    it('injects max into a background streaming language-model request', async () => {
      fetchMock.mockResolvedValueOnce(chatCompletionResponse(OPENROUTER_GPT_5_6_SOL_MODEL_ID, 'ok'))
      const model = createAiLanguageModel({
        providerKey: 'openrouter',
        selection: {
          provider: 'openrouter',
          modelId: OPENROUTER_GPT_5_6_SOL_MODEL_ID,
          modelKey: `openrouter::${OPENROUTER_GPT_5_6_SOL_MODEL_ID}`,
        },
        providerConfig: {
          id: 'openrouter',
          name: 'OpenRouter',
          apiKey: 'test-key',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
        executionMode: 'stream',
        reasoning: true,
        reasoningEffort: 'max',
      })

      await generateText({ model, prompt: 'hello', maxRetries: 0 })

      const body = await requestBodyOf(fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?])
      expect(body.reasoning).toEqual({ effort: 'max', summary: 'auto' })
    })
  })

  describe('LLM session ids are derived by the owning provider adapter', () => {
    it('derives the OpenRouter session id exactly like the session module', () => {
      const derived = openRouterAdapter.resolveLlmSessionId?.({
        kind: 'llm',
        userId: 'user-1',
        projectId: 'project-1',
        action: 'analyze',
        modelKey: 'openrouter::openai/gpt-5.5',
      })
      expect(derived).toBe(buildOpenRouterSessionId({
        kind: 'llm',
        userId: 'user-1',
        projectId: 'project-1',
        action: 'analyze',
        modelKey: 'openrouter::openai/gpt-5.5',
      }))
      expect(derived).toBeTruthy()
    })

    it('prefers a normalized explicit session id over derivation', () => {
      const explicit = openRouterAdapter.resolveLlmSessionId?.({
        kind: 'vision',
        userId: 'user-1',
        modelKey: 'openrouter::openai/gpt-5.5',
        explicitSessionId: '  My Session!!  ',
      })
      expect(explicit).toBe(normalizeOpenRouterSessionId('  My Session!!  '))
      expect(explicit).toBe('My_Session')
    })

    it('leaves providers without a session concept undefined', () => {
      expect(arkAdapter.resolveLlmSessionId).toBeUndefined()
      expect(googleAdapter.resolveLlmSessionId).toBeUndefined()
    })
  })

})
