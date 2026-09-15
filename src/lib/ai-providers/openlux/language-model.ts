import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai'
import type { AiProviderLanguageModelAdapter, AiProviderLanguageModelContext } from '@/lib/ai-providers/runtime-types'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import { AppError } from '@/lib/errors/app-error'
import { resolveOpenLuxBaseUrl } from './config'
import { assertOpenLuxResponse } from './http'

function withOpenLuxTimeout(init: RequestInit | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(300_000)
  return init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
}

function createOpenLuxGeminiModel(input: AiProviderLanguageModelContext) {
  const google = createGoogleGenerativeAI({
    apiKey: input.providerConfig.apiKey,
    baseURL: resolveOpenLuxBaseUrl(input.providerConfig.baseUrl, 'gemini'),
    name: 'openlux',
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers)
      headers.delete('x-goog-api-key')
      headers.set('Authorization', `Bearer ${input.providerConfig.apiKey}`)
      const response = await fetchWithProviderProxy(url, { ...init, headers, signal: withOpenLuxTimeout(init) })
      await assertOpenLuxResponse(response)
      return response
    },
  })
  const model = google.chat(input.selection.modelId)
  if (!input.reasoning) return model
  const maxThinkingBudget = input.selection.modelId === 'gemini-2.5-flash' ? 24576 : 32768
  const thinkingConfig = input.selection.modelId.startsWith('gemini-3')
    ? { thinkingLevel: input.reasoningEffort === 'low' ? 'low' : 'high', includeThoughts: true }
    : { thinkingBudget: input.reasoningEffort === 'low' ? 128 : maxThinkingBudget, includeThoughts: true }
  return wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({
    settings: { providerOptions: { google: { thinkingConfig } } },
  }) })
}

// OpenAI-series models use the gateway's OpenAI-compatible Responses surface; the
// same wire the Codex model gateway proxies for assistant Turns.
function createOpenLuxResponsesModel(input: AiProviderLanguageModelContext) {
  const openai = createOpenAI({
    apiKey: input.providerConfig.apiKey,
    baseURL: resolveOpenLuxBaseUrl(input.providerConfig.baseUrl, 'v1'),
    name: 'openlux',
    fetch: async (url, init) => {
      const response = await fetchWithProviderProxy(url, { ...init, signal: withOpenLuxTimeout(init) })
      await assertOpenLuxResponse(response)
      return response
    },
  })
  const model = openai.responses(input.selection.modelId)
  // The registry declares reasoning for every OpenLux GPT model; do not let the
  // SDK's model-name heuristics (unaware of GPT-6) silently drop the effort.
  return wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: {
    store: false,
    ...(input.reasoning ? { forceReasoning: true, reasoningEffort: input.reasoningEffort, reasoningSummary: 'auto' } : {}),
  } } } }) })
}

export function createOpenLuxLanguageModel(input: AiProviderLanguageModelContext) {
  if (input.protocol === 'google-generative-ai') return createOpenLuxGeminiModel(input)
  if (input.protocol === 'openai-responses') return createOpenLuxResponsesModel(input)
  throw new Error(`LLM_PROTOCOL_PROVIDER_MISMATCH:openlux:${input.protocol}`)
}

export const validateOpenLuxLanguageModelResult: NonNullable<AiProviderLanguageModelAdapter['validateResult']> = (result, context) => {
  if (result.text.trim()) return
  if (result.termination.kind === 'safety') {
    throw new AppError('SENSITIVE_CONTENT', 'OpenLux blocked generation', { provider: 'openlux', cause: result })
  }
  if (context.executionMode === 'vision') return
  throw new AppError('EMPTY_RESPONSE', 'OpenLux returned no text', { provider: 'openlux', cause: result })
}
