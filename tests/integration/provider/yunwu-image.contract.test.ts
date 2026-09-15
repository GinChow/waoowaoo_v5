import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeAiOptions } from '@/lib/ai-exec/normalize'
import {
  YUNWU_GPT_IMAGE_2_ALL_MODEL_ID,
  YUNWU_GPT_IMAGE_2_MODEL_ID,
  resolveYunwuOptionSchema,
} from '@/lib/ai-providers/yunwu/models'
import {
  requestYunwuImage,
  type YunwuImageOptions,
} from '@/lib/ai-providers/yunwu/image'
import { startScenarioServer } from '../../helpers/fakes/scenario-server'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { runRegisteredProviderOperation } from '@/lib/ai-providers'
import { findBuiltinPricingCatalogEntry } from '@/lib/ai-registry/pricing-catalog'
import { calcImage } from '@/lib/billing/cost'
import { findCarriedFailureRecord } from '@/lib/errors/normalize'

ensureAiCatalogsRegistered()

const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function normalizeImageOptions(
  modelId: string,
  options: Record<string, unknown>,
): YunwuImageOptions {
  return normalizeAiOptions({
    schema: resolveYunwuOptionSchema('image', modelId),
    options,
    context: 'yunwu-image-contract',
  }) as YunwuImageOptions
}

// Oracle: the Yunwu request/response protocol and limits are defined by
// test_api/src/yunwu-gpt-image-2*.ts; pricing parity is the approved product
// rule. Only the external Yunwu HTTP endpoint is replaced by the fake server.
describe('provider contract - Yunwu image', () => {
  let server: Awaited<ReturnType<typeof startScenarioServer>> | null = null

  beforeEach(async () => {
    server = await startScenarioServer()
  })

  afterEach(async () => {
    await server?.close()
    server = null
  })

  it('prices both Yunwu models exactly like OpenRouter GPT Image 2', () => {
    const openRouterPrice = findBuiltinPricingCatalogEntry(
      'image',
      'openrouter',
      'openai/gpt-image-2',
    )
    expect(openRouterPrice).not.toBeNull()
    for (const modelId of [YUNWU_GPT_IMAGE_2_MODEL_ID, YUNWU_GPT_IMAGE_2_ALL_MODEL_ID]) {
      const yunwuPrice = findBuiltinPricingCatalogEntry('image', 'yunwu', modelId)
      expect(yunwuPrice?.cost).toEqual(openRouterPrice?.cost)
      expect(yunwuPrice?.retail).toEqual(openRouterPrice?.retail)
      expect(calcImage(`yunwu::${modelId}`, 1, {
        imageSize: '1024x1024',
        quality: 'medium',
      })).toBe(calcImage('openrouter::openai/gpt-image-2', 1, {
        imageSize: '1024x1024',
        quality: 'medium',
      }))
    }
  })

  it('posts GPT Image 2 text-to-image requests to the generations endpoint', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/yunwu/images/generations',
      mode: 'success',
      submitResponse: {
        status: 200,
        body: { data: [{ b64_json: PNG_1X1_BASE64 }] },
      },
    })

    const result = await requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
      prompt: 'paint a quiet harbor',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_MODEL_ID, {
        aspectRatio: '1:1',
        resolution: '1K',
        quality: 'medium',
        outputFormat: 'webp',
      }),
    })

    expect(result).toEqual({
      success: true,
      imageBase64: PNG_1X1_BASE64,
      imageUrl: `data:image/webp;base64,${PNG_1X1_BASE64}`,
    })
    const requests = server!.getRequests('POST', '/yunwu/images/generations')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.authorization).toBe('Bearer yunwu-image-key')
    expect(requests[0]?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(requests[0]?.bodyText || '{}')).toEqual({
      model: 'gpt-image-2',
      prompt: 'paint a quiet harbor',
      n: 1,
      size: '1088x1088',
      quality: 'medium',
      format: 'webp',
    })
  })

  it('uses multipart edits when GPT Image 2 receives reference images', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/yunwu/images/edits',
      mode: 'success',
      submitResponse: {
        status: 200,
        body: { data: [{ b64_json: PNG_1X1_BASE64 }] },
      },
    })

    const result = await requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu/`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
      prompt: 'turn this into a watercolor',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_MODEL_ID, {
        aspectRatio: '1:1',
        referenceImages: [`data:image/png;base64,${PNG_1X1_BASE64}`],
      }),
    })

    expect(result.success).toBe(true)
    const requests = server!.getRequests('POST', '/yunwu/images/edits')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.authorization).toBe('Bearer yunwu-image-key')
    expect(requests[0]?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    const body = requests[0]?.bodyText || ''
    expect(body).toContain('name="model"\r\n\r\ngpt-image-2\r\n')
    expect(body).toContain('name="prompt"\r\n\r\nturn this into a watercolor\r\n')
    expect(body).toContain('name="n"\r\n\r\n1\r\n')
    expect(body).toContain('name="quality"\r\n\r\nhigh\r\n')
    expect(body).toContain('name="response_format"\r\n\r\nb64_json\r\n')
    expect(body).toContain('name="size"\r\n\r\n1088x1088\r\n')
    expect(body.match(/name="image"; filename="reference-1\.png"/gu)).toHaveLength(1)
    expect(body).toContain('Content-Type: image/png')
    expect(requests[0]?.bodyBuffer.subarray(0, 0)).toBeInstanceOf(Buffer)
    expect(requests[0]?.bodyBuffer.includes(Buffer.from(PNG_1X1_BASE64, 'base64'))).toBe(true)
  })

  it('sends GPT Image 2 All references as a JSON URL array', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/yunwu/images/generations',
      mode: 'success',
      submitResponse: {
        status: 200,
        body: { data: [{ url: 'https://cdn.example.com/generated.png' }] },
      },
    })

    const result = await requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_ALL_MODEL_ID,
      prompt: 'combine the two subjects',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_ALL_MODEL_ID, {
        aspectRatio: '3:2',
        referenceImages: [
          'https://8.8.8.8/one.png',
          'https://1.1.1.1/two.jpg',
        ],
      }),
    })

    expect(result).toEqual({
      success: true,
      imageUrl: 'https://cdn.example.com/generated.png',
    })
    const requests = server!.getRequests('POST', '/yunwu/images/generations')
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]?.bodyText || '{}')).toEqual({
      model: 'gpt-image-2-all',
      prompt: 'combine the two subjects',
      n: 1,
      size: '1536x1024',
      image: [
        'https://8.8.8.8/one.png',
        'https://1.1.1.1/two.jpg',
      ],
    })
  })

  it('extracts an image URL from nested JSON in choices content', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/yunwu/images/generations',
      mode: 'success',
      submitResponse: {
        status: 200,
        body: {
          choices: [{
            message: {
              content: JSON.stringify({
                result: { image_url: 'https://cdn.example.com/from-choice.png' },
              }),
            },
          }],
        },
      },
    })

    const result = await requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
      prompt: 'paint a lighthouse',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_MODEL_ID, {
        aspectRatio: '1:1',
      }),
    })

    expect(result).toEqual({
      success: true,
      imageUrl: 'https://cdn.example.com/from-choice.png',
    })
  })

  it.each([
    {
      label: 'an embedded data URL',
      content: `Image ready: data:image/png;base64,${PNG_1X1_BASE64} end`,
      expected: PNG_1X1_BASE64,
    },
    {
      label: 'a bare base64 payload',
      content: Buffer.alloc(900, 7).toString('base64'),
      expected: Buffer.alloc(900, 7).toString('base64'),
    },
  ])('extracts $label from choices content', async ({ content, expected }) => {
    server!.defineScenario({
      method: 'POST',
      path: '/yunwu/images/generations',
      mode: 'success',
      submitResponse: {
        status: 200,
        body: { choices: [{ message: { content } }] },
      },
    })

    const result = await requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
      prompt: 'paint a lighthouse',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_MODEL_ID, {
        aspectRatio: '1:1',
      }),
    })

    expect(result).toMatchObject({
      success: true,
      imageBase64: expected,
      imageUrl: `data:image/png;base64,${expected}`,
    })
  })

  it('rejects inline references for GPT Image 2 All before sending a request', async () => {
    await expect(requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_ALL_MODEL_ID,
      prompt: 'combine the subjects',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_ALL_MODEL_ID, {
        aspectRatio: '1:1',
        referenceImages: [`data:image/png;base64,${PNG_1X1_BASE64}`],
      }),
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'INVALID_PARAMS',
      disposition: 'pre_accept_rejected',
      message: 'YUNWU_GPT_IMAGE_2_ALL_REFERENCE_URL_REQUIRED:0',
    })

    expect(server!.getRequests('POST', '/yunwu/images/generations')).toHaveLength(0)
  })

  it.each([
    'http://cdn.example.com/image.png',
    'https://user:password@cdn.example.com/image.png',
    'https://127.0.0.1/image.png',
    'https://localhost/image.png',
  ])('rejects a non-public GPT Image 2 All reference before sending: %s', async (reference) => {
    await expect(requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_ALL_MODEL_ID,
      prompt: 'combine the subjects',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_ALL_MODEL_ID, {
        aspectRatio: '1:1',
        referenceImages: [reference],
      }),
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'INVALID_PARAMS',
      disposition: 'pre_accept_rejected',
      message: 'YUNWU_GPT_IMAGE_2_ALL_REFERENCE_URL_REQUIRED:0',
    })

    expect(server!.getRequests('POST', '/yunwu/images/generations')).toHaveLength(0)
  })

  it('rejects an oversized aggregate edit body before sending it', async () => {
    const reference = `data:image/png;base64,${Buffer.alloc(16 * 1024 * 1024 + 1, 7).toString('base64')}`
    await expect(requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
      prompt: 'combine the subjects',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_MODEL_ID, {
        aspectRatio: '1:1',
        referenceImages: [reference, reference],
      }),
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'PAYLOAD_TOO_LARGE',
      disposition: 'pre_accept_rejected',
      message: 'YUNWU_IMAGE_REFERENCES_TOTAL_TOO_LARGE:1',
    })

    expect(server!.getRequests('POST', '/yunwu/images/edits')).toHaveLength(0)
  })

  it('normalizes Yunwu HTTP authentication failures through the provider registry', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/yunwu/images/generations',
      mode: 'fatal_error',
      submitResponse: {
        status: 401,
        body: { error: { code: 'invalid_api_key', message: 'secret-key-was-rejected' } },
      },
    })

    const run = () => requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
      prompt: 'paint a lighthouse',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_MODEL_ID, { aspectRatio: '1:1' }),
    })
    const captured: unknown = await runRegisteredProviderOperation({
      providerId: 'yunwu',
      phase: 'submit',
      run,
    }).catch((error: unknown) => error)
    expect(captured).toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'PROVIDER_AUTH_INVALID',
      disposition: 'rejected',
      details: { httpStatus: 401, providerCode: 'invalid_api_key' },
    })
    expect(findCarriedFailureRecord(captured)).toMatchObject({
      interpretation: { code: 'PROVIDER_AUTH_INVALID' },
      context: { system: 'provider', provider: 'yunwu', phase: 'submit' },
    })
    expect(JSON.stringify(captured)).not.toContain('yunwu-image-key')
    expect(server!.getRequests('POST', '/yunwu/images/generations')).toHaveLength(1)
  })

  it('never retries an uncertain Yunwu image POST', async () => {
    server!.defineScenario({
      method: 'POST',
      path: '/yunwu/images/generations',
      mode: 'retryable_error_then_success',
      submitResponse: { status: 503, body: { error: { message: 'upstream unavailable' } } },
      pollSequence: [{ status: 200, body: { data: [{ b64_json: PNG_1X1_BASE64 }] } }],
    })

    await expect(requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
      prompt: 'paint a lighthouse',
      options: normalizeImageOptions(YUNWU_GPT_IMAGE_2_MODEL_ID, { aspectRatio: '1:1' }),
    })).rejects.toMatchObject({ name: 'ProviderHttpError', statusCode: 503 })
    expect(server!.getRequests('POST', '/yunwu/images/generations')).toHaveLength(1)
  })

  it('enforces the endpoint-specific GPT Image 2 prompt limits before sending', async () => {
    const textOptions = normalizeImageOptions(YUNWU_GPT_IMAGE_2_MODEL_ID, {
      aspectRatio: '1:1',
    })
    await expect(requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
      prompt: 'a'.repeat(1_001),
      options: textOptions,
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'INVALID_PARAMS',
      disposition: 'pre_accept_rejected',
      message: 'YUNWU_IMAGE_PROMPT_TOO_LONG:1000',
    })

    const editOptions = normalizeImageOptions(YUNWU_GPT_IMAGE_2_MODEL_ID, {
      aspectRatio: '1:1',
      referenceImages: [`data:image/png;base64,${PNG_1X1_BASE64}`],
    })
    await expect(requestYunwuImage({
      baseUrl: `${server!.baseUrl}/yunwu`,
      apiKey: 'yunwu-image-key',
      modelId: YUNWU_GPT_IMAGE_2_MODEL_ID,
      prompt: 'a'.repeat(32_001),
      options: editOptions,
    })).rejects.toMatchObject({
      name: 'ProviderSubmissionError',
      code: 'INVALID_PARAMS',
      disposition: 'pre_accept_rejected',
      message: 'YUNWU_IMAGE_PROMPT_TOO_LONG:32000',
    })

    expect(server!.getRequests('POST', '/yunwu/images/generations')).toHaveLength(0)
    expect(server!.getRequests('POST', '/yunwu/images/edits')).toHaveLength(0)
  })
})
