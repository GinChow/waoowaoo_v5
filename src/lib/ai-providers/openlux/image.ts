import type { AiProviderImageExecutionContext, GenerateResult } from '@/lib/ai-providers/runtime-types'
import type { GptImage2NormalizedOptions } from '@/lib/ai-providers/shared/gpt-image-2'
import { readProviderJsonResponse } from '@/lib/ai-providers/failure'
import { requireSelectedModelId } from '@/lib/ai-providers/shared/model-selection'
import { fetchWithProviderProxy } from '@/lib/http/outbound-proxy'
import { normalizeToBase64ForGeneration } from '@/lib/media/outbound-image'
import { AppError } from '@/lib/errors/app-error'
import { resolveOpenLuxBaseUrl } from './config'
import { assertOpenLuxResponse, rejectOpenLuxInput } from './http'

function projectImage(payload: unknown, outputFormat: string): GenerateResult {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const data = Array.isArray(record.data) ? [...record.data] : []
  // Some edits return JSON or Markdown image output inside choices[].message.content.
  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      const content = choice?.message?.content
      if (typeof content !== 'string') continue
      try {
        return projectImage(JSON.parse(content), outputFormat)
      } catch {
        const inline = content.match(/data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)/u)
        if (inline) data.push({ b64_json: inline[0] })
        else {
          const url = content.match(/https?:\/\/[^\s"'<>)]*/u)?.[0]
          if (url) data.push({ url })
        }
      }
    }
  }
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
      const value = item.b64_json.trim()
      const inline = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/u.exec(value)
      const imageBase64 = inline?.[2] ?? value
      const mime = inline?.[1] ?? (outputFormat === 'jpeg' ? 'image/jpeg' : `image/${outputFormat}`)
      return { success: true, imageBase64, imageUrl: `data:${mime};base64,${imageBase64}` }
    }
    if (typeof item.url === 'string' && /^https?:\/\//u.test(item.url)) return { success: true, imageUrl: item.url }
  }
  throw new AppError('EMPTY_RESPONSE', 'OpenLux returned no image', { provider: 'openlux', cause: payload })
}

export async function executeOpenLuxImage(input: AiProviderImageExecutionContext): Promise<GenerateResult> {
  const modelId = requireSelectedModelId(input.selection, 'openlux:image')
  const prompt = input.prompt.trim()
  if (!prompt || [...prompt].length > 1000) rejectOpenLuxInput('OPENLUX_IMAGE_PROMPT_MUST_BE_1_TO_1000_CHARACTERS')
  const options = input.options as GptImage2NormalizedOptions
  if (!options?.imageSize || !Array.isArray(options.referenceImages)) rejectOpenLuxInput('OPENLUX_IMAGE_OPTIONS_INCOMPLETE')
  const fields: Record<string, string | number> = {
    model: modelId, prompt, n: 1,
    size: `${options.imageSize.width}x${options.imageSize.height}`,
    quality: options.quality || 'high', format: options.outputFormat,
    response_format: typeof options.responseFormat === 'string' ? options.responseFormat : 'b64_json',
  }
  for (const key of ['background', 'moderation']) {
    if (typeof options[key] === 'string') fields[key] = options[key]
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${input.providerConfig.apiKey}`, Accept: 'application/json' }
  let body: string | FormData
  const edit = options.referenceImages.length > 0
  if (edit) {
    const form = new FormData()
    // Live gateway verification: edits use output_format (PNG/JPEG), while
    // generations use format. The sample edit script's format gets HTTP 400.
    for (const [key, value] of Object.entries(fields)) {
      form.append(key === 'format' ? 'output_format' : key, String(value))
    }
    for (const [index, reference] of options.referenceImages.entries()) {
      let normalized: string
      try { normalized = await normalizeToBase64ForGeneration(reference) }
      catch (cause) { rejectOpenLuxInput('OPENLUX_IMAGE_REFERENCE_INVALID', cause) }
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/u.exec(normalized)
      if (!match) rejectOpenLuxInput('OPENLUX_IMAGE_REFERENCE_INVALID')
      const bytes = Buffer.from(match[2], 'base64')
      if (!bytes.length || bytes.length > 50 * 1024 * 1024) rejectOpenLuxInput('OPENLUX_IMAGE_REFERENCE_TOO_LARGE_OR_EMPTY')
      form.append('image', new Blob([bytes], { type: match[1] }), `reference-${index + 1}.${match[1].split('/')[1]}`)
    }
    body = form
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(fields)
  }
  const response = await fetchWithProviderProxy(`${resolveOpenLuxBaseUrl(input.providerConfig.baseUrl, 'v1')}/images/${edit ? 'edits' : 'generations'}`, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(300_000),
  })
  await assertOpenLuxResponse(response)
  return projectImage(await readProviderJsonResponse({ response, provider: 'openlux', phase: 'result' }), options.outputFormat)
}
