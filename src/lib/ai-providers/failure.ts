import type { ExternalOperationId } from '@/lib/external-operation/registry'
import { readResponseBufferWithLimit } from '@/lib/http/body-limits'
import {
  fetchWithRetry,
  type FetchWithRetryOptions,
} from '@/lib/retry'
import type { UnifiedErrorCode } from '@/lib/errors/codes'
import {
  augmentFailureRecord,
  createFailureRecord,
} from '@/lib/errors/failure'
import {
  attachFailureToThrown,
  findCarriedFailureRecord,
  normalizeAnyError,
} from '@/lib/errors/normalize'
import type {
  AiProviderFailureAdapter,
  AiProviderFailureNormalizationInput,
  AiProviderFailurePhase,
} from './runtime-types'

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 40 * 1024 * 1024

function providerResponseRequestId(headers: Headers): string | null {
  return headers.get('x-request-id')?.trim()
    || headers.get('x-oai-request-id')?.trim()
    || headers.get('x-generation-id')?.trim()
    || headers.get('cf-ray')?.trim()
    || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function responseToken(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).trim()
  return normalized ? normalized.slice(0, 256) : null
}

function responseDiagnostic(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, 4_000) : null
}

export class ProviderHttpError extends Error {
  readonly provider: string
  readonly phase: AiProviderFailurePhase
  readonly statusCode: number
  readonly requestId: string | null
  readonly code: string | null
  readonly contentType: string | null
  readonly errorEnvelope: unknown
  readonly diagnosticText: string | null
  override readonly cause?: unknown

  constructor(input: {
    readonly provider: string
    readonly phase: AiProviderFailurePhase
    readonly statusCode: number
    readonly requestId?: string | null
    readonly code?: string | null
    readonly contentType?: string | null
    readonly errorEnvelope?: unknown
    readonly diagnosticText?: string | null
    readonly cause?: unknown
  }) {
    const diagnostic = input.diagnosticText?.trim().slice(0, 4_000)
      || `Provider returned HTTP ${String(input.statusCode)}`
    super(diagnostic, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = 'ProviderHttpError'
    this.provider = input.provider
    this.phase = input.phase
    this.statusCode = input.statusCode
    this.requestId = input.requestId?.trim().slice(0, 256) || null
    this.code = input.code?.trim().slice(0, 256) || null
    this.contentType = input.contentType?.trim().slice(0, 256) || null
    this.errorEnvelope = input.errorEnvelope ?? null
    this.diagnosticText = diagnostic
    this.cause = input.cause
  }
}

/**
 * The only parser for raw JSON Responses returned by Provider HTTP APIs.
 * Invalid, empty, unreadable, or oversized payloads fail with bounded native
 * evidence instead of letting response.json() erase the original body.
 */
export async function readProviderJsonResponse<T = unknown>(input: {
  readonly response: Response
  readonly provider: string
  readonly phase: AiProviderFailurePhase
  readonly maxBytes?: number
}): Promise<T> {
  const maxBytes = input.maxBytes ?? PROVIDER_JSON_RESPONSE_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PROVIDER_JSON_RESPONSE_MAX_BYTES) {
    throw new Error('AI_PROVIDER_JSON_RESPONSE_LIMIT_INVALID')
  }
  const requestId = providerResponseRequestId(input.response.headers)
  const contentType = input.response.headers.get('content-type')?.trim() || null
  let body: Buffer
  try {
    body = await readResponseBufferWithLimit(
      input.response,
      maxBytes,
      `${input.provider} Provider JSON response`,
    )
  } catch (cause: unknown) {
    throw new ProviderHttpError({
      provider: input.provider,
      phase: input.phase,
      statusCode: input.response.status,
      requestId,
      contentType,
      diagnosticText: `${input.provider} response could not be read within ${String(maxBytes)} bytes`,
      cause,
    })
  }

  const text = body.toString('utf8')
  try {
    return JSON.parse(text) as T
  } catch (cause: unknown) {
    throw new ProviderHttpError({
      provider: input.provider,
      phase: input.phase,
      statusCode: input.response.status,
      requestId,
      contentType,
      diagnosticText: text.trim().slice(0, 4_000)
        || `${input.provider} returned an empty JSON response`,
      errorEnvelope: text.trim().slice(0, 4_000) || null,
      cause,
    })
  }
}

const PROVIDER_EMBEDDED_JSON_MAX_BYTES = 4 * 1024 * 1024

/**
 * The only parser for JSON that a Provider embeds as a string inside an
 * already-bounded response (OpenAI-compatible gateways return image output
 * inside choices[].message.content). Unparseable or oversized text yields
 * null so callers keep treating it as plain content instead of a failure.
 */
export function parseProviderEmbeddedJson(
  text: string,
  maxBytes: number = PROVIDER_EMBEDDED_JSON_MAX_BYTES,
): unknown | null {
  const trimmed = text.trim()
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > maxBytes) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

export async function captureProviderHttpFailure(input: {
  readonly response: Response
  readonly provider: string
  readonly phase: AiProviderFailurePhase
  readonly maxBytes?: number
}): Promise<ProviderHttpError> {
  let payload: unknown
  try {
    payload = await readProviderJsonResponse(input)
  } catch (error: unknown) {
    if (error instanceof ProviderHttpError) return error
    throw error
  }
  const root = isRecord(payload) ? payload : null
  const error = isRecord(root?.error) ? root.error : null
  const detailEntry = Array.isArray(root?.detail) && isRecord(root.detail[0])
    ? root.detail[0]
    : null
  const diagnostic = responseDiagnostic(error?.message)
    ?? responseDiagnostic(root?.message)
    ?? responseDiagnostic(root?.detail)
    ?? responseDiagnostic(detailEntry?.message)
    ?? responseDiagnostic(detailEntry?.msg)
    ?? responseToken(detailEntry?.type)
    ?? `${input.provider} returned HTTP ${String(input.response.status)}`
  return new ProviderHttpError({
    provider: input.provider,
    phase: input.phase,
    statusCode: input.response.status,
    requestId: providerResponseRequestId(input.response.headers),
    code: responseToken(error?.code)
      ?? responseToken(root?.code)
      ?? responseToken(detailEntry?.code)
      ?? responseToken(detailEntry?.type),
    contentType: input.response.headers.get('content-type'),
    diagnosticText: diagnostic,
    errorEnvelope: payload,
  })
}

/**
 * The only retrying Provider fetch. Generic fetchWithRetry keeps its legacy
 * text error for non-Provider callers; this boundary always turns a non-2xx
 * Provider response into bounded native evidence before retry policy sees it.
 */
export async function fetchProviderWithRetry(input: {
  readonly url: string
  readonly provider: string
  readonly phase: AiProviderFailurePhase
  readonly options: FetchWithRetryOptions
}): Promise<Response> {
  return await fetchWithRetry(input.url, {
    ...input.options,
    httpErrorFactory: async (response) => await captureProviderHttpFailure({
      response,
      provider: input.provider,
      phase: input.phase,
    }),
  })
}

type ErrorLike = {
  readonly cause?: unknown
  readonly failure?: unknown
  readonly status?: unknown
  readonly statusCode?: unknown
}

function readStatus(value: unknown): number | null {
  const status = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{3}$/u.test(value.trim())
      ? Number.parseInt(value, 10)
      : Number.NaN
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null
}

function findSourceStatus(value: unknown): number | null {
  let current: unknown = value
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 12; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) return null
    seen.add(current)
    const record = current as ErrorLike
    const status = readStatus(record.statusCode) ?? readStatus(record.status)
    if (status !== null) return status
    current = record.cause
  }
  return null
}

function fallbackCode(phase: AiProviderFailurePhase): UnifiedErrorCode {
  if (phase === 'submit') return 'PROVIDER_SUBMIT_FAILED'
  if (phase === 'poll' || phase === 'cancel') return 'PROVIDER_POLL_FAILED'
  return 'EXTERNAL_ERROR'
}

function providerHttpCode(
  status: number,
  phase: AiProviderFailurePhase,
): UnifiedErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_INVALID'
  if (status === 402) return 'PROVIDER_BILLING_REQUIRED'
  if (status === 408 || status === 504) return 'NETWORK_ERROR'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'EXTERNAL_ERROR'
  if (status >= 400 && phase === 'submit') return 'PROVIDER_SUBMISSION_REJECTED'
  if (status >= 400 && (phase === 'poll' || phase === 'cancel')) return 'PROVIDER_POLL_FAILED'
  if (status >= 400) return 'EXTERNAL_ERROR'
  return fallbackCode(phase)
}

/**
 * The mandatory fallback for one Provider. Provider-private code may attach a
 * more specific FailureRecord first; this boundary preserves it. Unclassified
 * future errors remain explicit and keep their first native thrown value.
 */
export function createAiProviderFailureAdapter(
  providerKey: string,
): AiProviderFailureAdapter {
  const normalizedProviderKey = providerKey.trim().toLowerCase()
  if (!normalizedProviderKey) throw new Error('AI_PROVIDER_FAILURE_KEY_REQUIRED')
  return {
    providerKey: normalizedProviderKey,
    normalize: (input) => {
      const context = {
        system: 'provider' as const,
        provider: normalizedProviderKey,
        phase: input.phase,
        ...(input.operation ? { operation: input.operation } : {}),
      }
      const carried = findCarriedFailureRecord(input.error)
      const sourceStatus = findSourceStatus(input.error)
      if (input.error instanceof ProviderHttpError) {
        return createFailureRecord(
          providerHttpCode(input.error.statusCode, input.phase),
          input.error.message,
          {
            cause: input.error,
            context,
            operation: input.operation,
            attempts: input.attempts,
          },
        )
      }
      if (carried) {
        const ownsInterpretation = carried.context.system === 'provider'
          && carried.context.provider === normalizedProviderKey
        return augmentFailureRecord(carried, {
          ...(ownsInterpretation
            ? {}
            : {
                code: sourceStatus === null
                  ? carried.interpretation.code
                  : providerHttpCode(sourceStatus, input.phase),
              }),
          context,
          operation: input.operation,
          attempts: input.attempts,
        })
      }
      const normalized = normalizeAnyError(input.error, {
        fallbackCode: fallbackCode(input.phase),
        context,
        operation: input.operation,
        attempts: input.attempts,
      })
      const code = sourceStatus === null
        ? normalized.interpretation.code
        : providerHttpCode(sourceStatus, input.phase)
      if (normalized.context.system === 'provider'
        && normalized.context.provider === normalizedProviderKey
        && code === normalized.interpretation.code) {
        return normalized
      }
      return createFailureRecord(code, normalized.native.message, {
        cause: input.error,
        details: normalized.interpretation.details,
        context,
        operation: input.operation,
        attempts: input.attempts,
      })
    },
  }
}

export function assertProviderFailureAdapterIdentity(
  providerKey: string,
  failure: AiProviderFailureAdapter,
): void {
  if (failure.providerKey !== providerKey.trim().toLowerCase()) {
    throw new Error(`AI_PROVIDER_FAILURE_IDENTITY_MISMATCH:${providerKey}:${failure.providerKey}`)
  }
}

export function throwCapturedProviderFailure(
  adapter: AiProviderFailureAdapter,
  input: AiProviderFailureNormalizationInput,
): never {
  throw attachFailureToThrown(input.error, adapter.normalize(input))
}

export async function runCapturedProviderOperation<T>(input: {
  readonly adapter: AiProviderFailureAdapter
  readonly phase: AiProviderFailurePhase
  readonly operation?: ExternalOperationId
  readonly run: () => Promise<T>
}): Promise<T> {
  try {
    return await input.run()
  } catch (error: unknown) {
    throwCapturedProviderFailure(input.adapter, {
      error,
      phase: input.phase,
      operation: input.operation,
    })
  }
}
