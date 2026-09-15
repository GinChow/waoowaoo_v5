export const OPENLUX_DEFAULT_BASE_URL = 'https://api.openlux.ai/v1'

// One configured gateway root serves the OpenAI-compatible /v1 surface
// (images, responses) and native Gemini under /v1beta.
export function resolveOpenLuxBaseUrl(baseUrl: string | undefined, protocol: 'v1' | 'gemini'): string {
  const root = (baseUrl?.trim() || OPENLUX_DEFAULT_BASE_URL)
    .replace(/\/+$/u, '')
    .replace(/\/v1beta(?:\/models)?$|\/v1$/u, '')
  return `${root}/${protocol === 'gemini' ? 'v1beta' : 'v1'}`
}
