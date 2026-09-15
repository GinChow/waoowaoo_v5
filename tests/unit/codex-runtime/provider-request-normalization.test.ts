import { describe, expect, it } from 'vitest'
import {
  normalizeCodexProviderRequest,
} from '@/lib/codex-model-gateway/proxy'
import { projectCodexProviderResponse } from '@/lib/codex-model-gateway/error-projection'

describe('Codex provider request normalization', () => {
  it('lifts interleaved developer messages while preserving model history order', () => {
    const request: Record<string, unknown> = {
      instructions: 'codex base',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'workspace contract' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'original request' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'partial work' }],
        },
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'current permissions' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      ],
    }

    normalizeCodexProviderRequest(request)

    expect(request.instructions).toBe(
      'codex base\n\nworkspace contract\n\ncurrent permissions',
    )
    expect((request.input as Array<{ role: string }>).map((item) => item.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
  })

  it('rejects an instruction item that cannot be preserved exactly', () => {
    expect(() => normalizeCodexProviderRequest({
      input: [{
        type: 'message',
        role: 'developer',
        content: [{ type: 'output_text', text: 'invalid' }],
      }],
    })).toThrow('CODEX_MODEL_GATEWAY_REQUEST_INSTRUCTIONS_INVALID')
  })

  it('drops interrupted summary-only reasoning while preserving encrypted reasoning', () => {
    const interrupted = {
      type: 'reasoning',
      id: 'rs_interrupted',
      summary: [{ type: 'summary_text', text: 'partial reasoning' }],
      content: null,
      encrypted_content: null,
    }
    const replayable = {
      type: 'reasoning',
      id: 'rs_complete',
      summary: [],
      content: null,
      encrypted_content: 'encrypted-state',
    }
    const request: Record<string, unknown> = {
      store: false,
      input: [interrupted, replayable],
    }

    normalizeCodexProviderRequest(request)

    expect(request.input).toEqual([replayable])
  })

  it.each([
    {
      providerStatus: 402,
      providerError: { type: 'payment_required', code: 'insufficient_credits' },
      expectedStatus: 429,
      expectedCode: 'usage_not_included',
      expectedKind: 'billing_required',
    },
    {
      providerStatus: 401,
      providerError: { type: 'authentication_error', code: 'invalid_api_key' },
      expectedStatus: 503,
      expectedCode: 'slow_down',
      expectedKind: 'configuration_unavailable',
    },
    {
      providerStatus: 422,
      providerError: { type: 'invalid_request_error', code: 'invalid_request' },
      expectedStatus: 400,
      expectedCode: 'invalid_request',
      expectedKind: 'request_rejected',
    },
    {
      providerStatus: 503,
      providerError: { type: 'server_error', code: 'provider_down' },
      expectedStatus: 503,
      expectedCode: 'slow_down',
      expectedKind: 'temporarily_unavailable',
    },
    {
      providerStatus: 400,
      providerError: { type: 'invalid_request_error', code: 'content_policy_violation' },
      expectedStatus: 200,
      expectedCode: 'cyber_policy',
      expectedKind: 'policy_rejected',
    },
  ])('projects Provider $providerStatus into the official Codex error vocabulary', async ({
    providerStatus,
    providerError,
    expectedStatus,
    expectedCode,
    expectedKind,
  }) => {
    const projected = await projectCodexProviderResponse(Response.json({
      error: { ...providerError, message: 'provider-private-message' },
    }, { status: providerStatus }), 'openrouter')

    expect(projected.failureKind).toBe(expectedKind)
    expect(projected.providerStatus).toBe(providerStatus)
    expect(projected.failure).toMatchObject({
      version: 2,
      native: {
        message: 'provider-private-message',
        statusCode: providerStatus,
      },
      context: { system: 'provider', provider: 'openrouter', phase: 'submit' },
    })
    expect(projected.response.status).toBe(expectedStatus)
    expect(await projected.response.text()).toContain(`\"code\":\"${expectedCode}\"`)
  })

  it('preserves the documented OpenRouter Responses error type and diagnostic', async () => {
    const projected = await projectCodexProviderResponse(Response.json({
      id: 'resp_failed',
      status: 'failed',
      error: {
        code: 'invalid_prompt',
        message: 'Item ctc_123 was provided without its required output.',
      },
      error_type: 'invalid_request',
    }, { status: 400 }), 'openrouter')

    expect(projected.failureKind).toBe('request_rejected')
    expect(projected.providerStatus).toBe(400)
    expect(projected.providerCode).toBe('invalid_prompt')
    expect(projected.providerErrorType).toBe('invalid_request')
    expect(projected.failure?.native).toMatchObject({
      message: 'Item ctc_123 was provided without its required output.',
      code: 'invalid_prompt',
      statusCode: 400,
    })
    expect(projected.response.status).toBe(400)
    expect(await projected.response.text()).toContain(
      'Item ctc_123 was provided without its required output.',
    )
  })

  it('unwraps OpenRouter BYOK provider diagnostics hidden in metadata.raw', async () => {
    const projected = await projectCodexProviderResponse(Response.json({
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: {
          provider_error_code: 'invalid_encrypted_content',
          raw: JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'invalid_encrypted_content',
              message: 'Encrypted content item_id did not match the target item id.',
            },
          }),
        },
      },
    }, { status: 400 }), 'openrouter')

    expect(projected.failureKind).toBe('request_rejected')
    expect(projected.providerCode).toBe('invalid_encrypted_content')
    expect(projected.failure?.native).toMatchObject({
      message: 'Encrypted content item_id did not match the target item id.',
      code: 'invalid_encrypted_content',
      statusCode: 400,
    })
    expect(projected.response.status).toBe(400)
    expect(await projected.response.text()).toContain(
      'Encrypted content item_id did not match the target item id.',
    )
  })

  it('preserves a Provider rate-limit response and its retry boundary', async () => {
    const projected = await projectCodexProviderResponse(Response.json({
      error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    }, {
      status: 429,
      headers: { 'Retry-After': '12' },
    }), 'openrouter')

    expect(projected.failureKind).toBe('rate_limited')
    expect(projected.response.status).toBe(429)
    expect(projected.response.headers.get('retry-after')).toBe('12')
  })

  it('keeps an unknown future JSON envelope unknown without losing its HTTP fact', async () => {
    const projected = await projectCodexProviderResponse(Response.json({
      future_error: {
        identity: 'FUTURE_418',
        diagnostic: 'new envelope shape',
      },
    }, {
      status: 418,
      headers: { 'x-request-id': 'future-request-418' },
    }), 'openrouter')

    expect(projected.failureKind).toBe('request_rejected')
    expect(projected.failure).toMatchObject({
      version: 2,
      native: {
        name: 'ProviderHttpError',
        message: 'Provider returned HTTP 418',
        statusCode: 418,
        requestId: 'future-request-418',
      },
    })
    expect(JSON.stringify(projected.failure)).toContain('FUTURE_418')
  })

  it('preserves bounded non-JSON diagnostics and records oversized bodies explicitly', async () => {
    const textFailure = await projectCodexProviderResponse(new Response(
      'upstream proxy rejected this request',
      { status: 502, headers: { 'content-type': 'text/plain' } },
    ), 'openrouter')
    expect(textFailure.failure?.native).toMatchObject({
      message: 'upstream proxy rejected this request',
      statusCode: 502,
    })

    const oversized = await projectCodexProviderResponse(new Response(
      'x'.repeat(70 * 1024),
      { status: 502, headers: { 'content-type': 'text/plain' } },
    ), 'openrouter')
    expect(oversized.failure?.native.message).toContain('could not be read within 65536 bytes')
    expect(oversized.failure?.native.statusCode).toBe(502)
    expect(oversized.failure?.native.cause).not.toBeNull()
  })
})
