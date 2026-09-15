import type { AiProviderImageExecutionContext, GenerateResult } from '@/lib/ai-providers/runtime-types'
import { ProviderSubmissionError } from '@/lib/ai-exec/submission-error'
import type { UnifiedErrorCode } from '@/lib/errors/codes'
import type { GptImage2ImageSize } from '@/lib/ai-providers/shared/gpt-image-2'
import { requireSelectedModelId } from '@/lib/ai-providers/shared/model-selection'
import {
  captureProviderHttpFailure,
  parseProviderEmbeddedJson,
  readProviderJsonResponse,
} from '@/lib/ai-providers/failure'
import { normalizeToBase64ForGeneration } from '@/lib/media/outbound-image'
import { assertSafeOutboundMediaUrl } from '@/lib/media/outbound-fetch'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import { AppError } from '@/lib/errors/app-error'
import {
  YUNWU_GPT_IMAGE_2_ALL_MODEL_ID,
  YUNWU_GPT_IMAGE_2_MODEL_ID,
} from './models'

const YUNWU_IMAGE_TIMEOUT_MS = 5 * 60_000
const YUNWU_EDIT_IMAGE_MAX_BYTES = 25 * 1024 * 1024
const YUNWU_EDIT_IMAGES_TOTAL_MAX_BYTES = 32 * 1024 * 1024
const YUNWU_RESPONSE_IMAGE_MAX_BYTES = 25 * 1024 * 1024
const YUNWU_EXPLICIT_REJECTION_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422])

export type YunwuImageOptions = Record<string, unknown> & {
  aspectRatio: string
  resolution: string
  quality: string
  outputFormat: string
  referenceImages: string[]
  imageSize?: GptImage2ImageSize
  wireSize?: string
}

type ExtractedImage = {
  url?: string
  base64?: string
}

function throwPreAcceptRejection(
  code: UnifiedErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new ProviderSubmissionError(code, message, {
    disposition: 'pre_accept_rejected',
    provider: 'yunwu',
    cause: cause === undefined ? new Error(message) : cause,
  })
}

function explicitRejectionCode(status: number): UnifiedErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_INVALID'
  if (status === 402) return 'PROVIDER_BILLING_REQUIRED'
  return 'PROVIDER_SUBMISSION_REJECTED'
}

async function throwYunwuHttpFailure(response: Response): Promise<never> {
  const error = await captureProviderHttpFailure({
    response,
    provider: 'yunwu',
    phase: 'submit',
  })
  if (!YUNWU_EXPLICIT_REJECTION_STATUSES.has(response.status)) throw error
  throw new ProviderSubmissionError(
    explicitRejectionCode(response.status),
    error.message,
    {
      disposition: 'rejected',
      provider: 'yunwu',
      details: {
        httpStatus: response.status,
        providerCode: error.code,
      },
      cause: error,
    },
  )
}

function imageEndpoint(baseUrl: string, endpoint: 'generations' | 'edits'): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, '')
  if (!normalized) {
    throwPreAcceptRejection('MISSING_CONFIG', 'PROVIDER_BASE_URL_MISSING: yunwu (image)')
  }
  return `${normalized}/images/${endpoint}`
}

function requirePrompt(prompt: string): string {
  const normalized = prompt.trim()
  if (!normalized) throwPreAcceptRejection('INVALID_PARAMS', 'YUNWU_IMAGE_PROMPT_REQUIRED')
  return normalized
}

function assertPromptLength(prompt: string, maxCharacters: number): void {
  if ([...prompt].length > maxCharacters) {
    throwPreAcceptRejection(
      'INVALID_PARAMS',
      `YUNWU_IMAGE_PROMPT_TOO_LONG:${String(maxCharacters)}`,
    )
  }
}

function requireApiKey(apiKey: string): string {
  const normalized = apiKey.trim()
  if (!normalized) {
    throwPreAcceptRejection('PROVIDER_AUTH_INVALID', 'YUNWU_API_KEY_REQUIRED')
  }
  return normalized
}

function mimeTypeForFormat(format: string): string {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

function normalizeBase64Payload(value: string, minimumCharacters = 1): string | null {
  const normalized = value.replace(/\s/gu, '')
  if (normalized.length < minimumCharacters || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) return null
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  const decodedBytes = Math.floor(normalized.length * 3 / 4) - padding
  if (decodedBytes < 1 || decodedBytes > YUNWU_RESPONSE_IMAGE_MAX_BYTES) return null
  const decoded = Buffer.from(normalized, 'base64')
  if (
    decoded.byteLength !== decodedBytes
    || decoded.toString('base64').replace(/=+$/u, '') !== normalized.replace(/=+$/u, '')
  ) return null
  return normalized
}

function extractDataUrlBase64(value: string): string | null {
  const match = /data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)/u.exec(value)
  return match?.[1] ? normalizeBase64Payload(match[1]) : null
}

function collectImagesFromContent(content: string): ExtractedImage[] {
  const trimmed = content.trim()
  if (!trimmed) return []
  const embedded = parseProviderEmbeddedJson(trimmed)
  if (embedded !== null) return collectImages(embedded)
  const dataUrlBase64 = extractDataUrlBase64(trimmed)
  if (dataUrlBase64) return [{ base64: dataUrlBase64 }]
  const url = trimmed.match(/https?:\/\/[^\s"'<>)]*/u)?.[0]
  if (url) return [{ url }]
  const bareBase64 = normalizeBase64Payload(trimmed, 1_000)
  return bareBase64 ? [{ base64: bareBase64 }] : []
}

function collectImages(payload: unknown): ExtractedImage[] {
  const images: ExtractedImage[] = []
  const queue: unknown[] = [payload]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }

    const record = current as Record<string, unknown>
    const url = record.url ?? record.image_url ?? record.imageUrl
    const base64 = record.b64_json
      ?? record.b64Json
      ?? record.base64
      ?? record.image_base64
      ?? record.imageBase64
    if (typeof url === 'string' && /^https?:\/\//u.test(url)) {
      images.push({ url })
    }
    if (typeof base64 === 'string' && base64.trim()) {
      const normalizedBase64 = extractDataUrlBase64(base64) ?? normalizeBase64Payload(base64)
      if (normalizedBase64) images.push({ base64: normalizedBase64 })
    }
    if (typeof record.content === 'string') {
      images.push(...collectImagesFromContent(record.content))
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') queue.push(value)
    }
  }
  return Array.from(new Map(images.map((image) => [
    image.url ? `url:${image.url}` : `base64:${image.base64}`,
    image,
  ])).values())
}

function projectImageResponse(
  payload: unknown,
  mimeType: string,
): GenerateResult {
  const image = collectImages(payload)[0]
  if (!image) {
    throw new AppError('EMPTY_RESPONSE', 'Yunwu returned no image', {
      provider: 'yunwu',
      cause: payload,
    })
  }
  if (image.url) return { success: true, imageUrl: image.url }
  const imageBase64 = image.base64 as string
  return {
    success: true,
    imageBase64,
    imageUrl: `data:${mimeType};base64,${imageBase64}`,
  }
}

async function requestJson(input: {
  url: string
  apiKey: string
  body: Record<string, unknown>
}): Promise<unknown> {
  const response = await fetchWithProviderProxy(input.url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(YUNWU_IMAGE_TIMEOUT_MS),
  })
  if (!response.ok) {
    await throwYunwuHttpFailure(response)
  }
  return await readProviderJsonResponse({
    response,
    provider: 'yunwu',
    phase: 'result',
  })
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

async function appendEditReference(
  form: FormData,
  reference: string,
  index: number,
  accumulatedBytes: number,
): Promise<number> {
  let normalized: string
  try {
    normalized = await normalizeToBase64ForGeneration(reference)
  } catch (cause: unknown) {
    throwPreAcceptRejection('INVALID_PARAMS', 'YUNWU_IMAGE_REFERENCE_INVALID', cause)
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/u.exec(normalized)
  if (!match) throwPreAcceptRejection('INVALID_PARAMS', 'YUNWU_IMAGE_REFERENCE_INVALID')
  const mimeType = match[1]
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.byteLength > YUNWU_EDIT_IMAGE_MAX_BYTES) {
    throwPreAcceptRejection(
      'PAYLOAD_TOO_LARGE',
      `YUNWU_IMAGE_REFERENCE_TOO_LARGE:${String(index)}`,
    )
  }
  const totalBytes = assertYunwuEditReferenceTotalBytes({
    accumulatedBytes,
    nextBytes: bytes.byteLength,
    referenceIndex: index,
  })
  form.append(
    'image',
    new Blob([bytes], { type: mimeType }),
    `reference-${String(index + 1)}.${extensionForMimeType(mimeType)}`,
  )
  return totalBytes
}

function assertYunwuEditReferenceTotalBytes(input: {
  accumulatedBytes: number
  nextBytes: number
  referenceIndex: number
}): number {
  if (
    !Number.isSafeInteger(input.accumulatedBytes)
    || input.accumulatedBytes < 0
    || !Number.isSafeInteger(input.nextBytes)
    || input.nextBytes < 0
  ) {
    throwPreAcceptRejection('INVALID_PARAMS', 'YUNWU_IMAGE_REFERENCE_SIZE_INVALID')
  }
  const totalBytes = input.accumulatedBytes + input.nextBytes
  if (!Number.isSafeInteger(totalBytes) || totalBytes > YUNWU_EDIT_IMAGES_TOTAL_MAX_BYTES) {
    throwPreAcceptRejection(
      'PAYLOAD_TOO_LARGE',
      `YUNWU_IMAGE_REFERENCES_TOTAL_TOO_LARGE:${String(input.referenceIndex)}`,
    )
  }
  return totalBytes
}

async function requestGptImage2Edit(input: {
  baseUrl: string
  apiKey: string
  modelId: string
  prompt: string
  options: YunwuImageOptions
}): Promise<GenerateResult> {
  const form = new FormData()
  form.append('model', input.modelId)
  form.append('prompt', input.prompt)
  form.append('n', '1')
  form.append('quality', input.options.quality)
  form.append('response_format', 'b64_json')
  const size = input.options.imageSize
  if (!size) {
    throwPreAcceptRejection('INVALID_PARAMS', 'YUNWU_GPT_IMAGE_2_OPTIONS_INCOMPLETE')
  }
  form.append('size', `${String(size.width)}x${String(size.height)}`)
  let totalReferenceBytes = 0
  for (const [index, reference] of input.options.referenceImages.entries()) {
    totalReferenceBytes = await appendEditReference(form, reference, index, totalReferenceBytes)
  }

  const response = await fetchWithProviderProxy(imageEndpoint(input.baseUrl, 'edits'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${input.apiKey}`,
    },
    body: form,
    signal: AbortSignal.timeout(YUNWU_IMAGE_TIMEOUT_MS),
  })
  if (!response.ok) {
    await throwYunwuHttpFailure(response)
  }
  const payload = await readProviderJsonResponse({
    response,
    provider: 'yunwu',
    phase: 'result',
  })
  return projectImageResponse(payload, 'image/png')
}

async function requirePublicHttpsReference(reference: string, index: number): Promise<string> {
  let url: URL
  try {
    url = new URL(reference)
  } catch (cause: unknown) {
    throwPreAcceptRejection(
      'INVALID_PARAMS',
      `YUNWU_GPT_IMAGE_2_ALL_REFERENCE_URL_REQUIRED:${String(index)}`,
      cause,
    )
  }
  if (url.protocol !== 'https:') {
    throwPreAcceptRejection(
      'INVALID_PARAMS',
      `YUNWU_GPT_IMAGE_2_ALL_REFERENCE_URL_REQUIRED:${String(index)}`,
    )
  }
  try {
    return (await assertSafeOutboundMediaUrl(url)).toString()
  } catch (cause: unknown) {
    throwPreAcceptRejection(
      'INVALID_PARAMS',
      `YUNWU_GPT_IMAGE_2_ALL_REFERENCE_URL_REQUIRED:${String(index)}`,
      cause,
    )
  }
}

export async function requestYunwuImage(input: {
  baseUrl: string
  apiKey: string
  modelId: string
  prompt: string
  options: YunwuImageOptions
}): Promise<GenerateResult> {
  const apiKey = requireApiKey(input.apiKey)
  const prompt = requirePrompt(input.prompt)
  const references = input.options.referenceImages

  if (input.modelId === YUNWU_GPT_IMAGE_2_MODEL_ID) {
    if (references.length > 0) {
      assertPromptLength(prompt, 32_000)
      return await requestGptImage2Edit({ ...input, apiKey, prompt })
    }
    assertPromptLength(prompt, 1_000)
    const size = input.options.imageSize
    if (!size) {
      throwPreAcceptRejection('INVALID_PARAMS', 'YUNWU_GPT_IMAGE_2_OPTIONS_INCOMPLETE')
    }
    const payload = await requestJson({
      url: imageEndpoint(input.baseUrl, 'generations'),
      apiKey,
      body: {
        model: input.modelId,
        prompt,
        n: 1,
        size: `${String(size.width)}x${String(size.height)}`,
        quality: input.options.quality,
        format: input.options.outputFormat,
      },
    })
    return projectImageResponse(payload, mimeTypeForFormat(input.options.outputFormat))
  }

  if (input.modelId === YUNWU_GPT_IMAGE_2_ALL_MODEL_ID) {
    const publicReferences: string[] = []
    for (const [index, reference] of references.entries()) {
      publicReferences.push(await requirePublicHttpsReference(reference, index))
    }
    const payload = await requestJson({
      url: imageEndpoint(input.baseUrl, 'generations'),
      apiKey,
      body: {
        model: input.modelId,
        prompt,
        n: 1,
        size: input.options.wireSize,
        ...(publicReferences.length > 0 ? { image: publicReferences } : {}),
      },
    })
    return projectImageResponse(payload, 'image/png')
  }

  throwPreAcceptRejection('INVALID_PARAMS', `YUNWU_IMAGE_MODEL_UNSUPPORTED:${input.modelId}`)
}

export async function executeYunwuImageGeneration(
  input: AiProviderImageExecutionContext,
): Promise<GenerateResult> {
  const modelId = requireSelectedModelId(input.selection, 'yunwu:image')
  const baseUrl = input.providerConfig.baseUrl?.trim()
  if (!baseUrl) {
    throwPreAcceptRejection('MISSING_CONFIG', 'PROVIDER_BASE_URL_MISSING: yunwu (image)')
  }
  return await requestYunwuImage({
    baseUrl,
    apiKey: input.providerConfig.apiKey,
    modelId,
    prompt: input.prompt,
    options: input.options as YunwuImageOptions,
  })
}
