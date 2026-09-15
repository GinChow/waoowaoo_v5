import { ProviderSubmissionError } from '@/lib/ai-exec/submission-error'
import { captureProviderHttpFailure } from '@/lib/ai-providers/failure'
import type { UnifiedErrorCode } from '@/lib/errors/codes'

export function rejectOpenLuxInput(message: string, cause: unknown = new Error(message)): never {
  throw new ProviderSubmissionError('INVALID_PARAMS', message, {
    provider: 'openlux', disposition: 'pre_accept_rejected', cause,
  })
}

export async function assertOpenLuxResponse(response: Response): Promise<void> {
  if (response.ok) return
  const failure = await captureProviderHttpFailure({ response, provider: 'openlux', phase: 'submit' })
  // Timeouts, rate limits and server errors do not prove non-acceptance.
  if (![400, 401, 402, 403, 404, 413, 422].includes(response.status)) throw failure
  const code: UnifiedErrorCode = response.status === 401 || response.status === 403
    ? 'PROVIDER_AUTH_INVALID'
    : response.status === 402 ? 'PROVIDER_BILLING_REQUIRED' : 'PROVIDER_SUBMISSION_REJECTED'
  throw new ProviderSubmissionError(code, failure.message, {
    provider: 'openlux', disposition: 'rejected', cause: failure,
    details: { httpStatus: response.status },
  })
}
