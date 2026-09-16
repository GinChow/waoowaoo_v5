import { ProviderSubmissionError } from '@/lib/ai-exec/submission-error'
import { captureProviderHttpFailure } from '@/lib/ai-providers/failure'
import type { UnifiedErrorCode } from '@/lib/errors/codes'

export function rejectMetasoInput(message: string, cause: unknown = new Error(message)): never {
  throw new ProviderSubmissionError('INVALID_PARAMS', message, {
    provider: 'metaso', disposition: 'pre_accept_rejected', cause,
  })
}

function readMiniMaxErrorType(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return null
  const error = (envelope as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null
  const type = (error as { type?: unknown }).type
  return typeof type === 'string' && type.trim() ? type.trim() : null
}

// MiniMax rejects with HTTP 4xx and { type: 'error', error: { type, message, http_code } }.
// Timeouts, rate limits and server errors do not prove non-acceptance.
export async function assertMetasoSubmissionResponse(response: Response): Promise<void> {
  if (response.ok) return
  const failure = await captureProviderHttpFailure({ response, provider: 'metaso', phase: 'submit' })
  if (![400, 401, 402, 403, 404, 413, 422].includes(response.status)) throw failure
  const errorType = readMiniMaxErrorType(failure.errorEnvelope)
  const code: UnifiedErrorCode = response.status === 401 || response.status === 403 || errorType === 'authorized_error'
    ? 'PROVIDER_AUTH_INVALID'
    : response.status === 402 ? 'PROVIDER_BILLING_REQUIRED' : 'PROVIDER_SUBMISSION_REJECTED'
  throw new ProviderSubmissionError(code, failure.message, {
    provider: 'metaso', disposition: 'rejected', cause: failure,
    details: { httpStatus: response.status, ...(errorType ? { providerCode: errorType } : {}) },
  })
}
