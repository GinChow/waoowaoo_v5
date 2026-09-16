export const OPENLUX_DEFAULT_BASE_URL = 'https://api.openlux.ai/v1'

// One configured gateway root serves the OpenAI-compatible /v1 surface
// (images, responses), native Gemini under /v1beta and the Ark passthrough
// (Seedance video tasks) under /api/v3.
export function resolveOpenLuxBaseUrl(baseUrl: string | undefined, protocol: 'v1' | 'gemini' | 'ark'): string {
  const root = (baseUrl?.trim() || OPENLUX_DEFAULT_BASE_URL)
    .replace(/\/+$/u, '')
    .replace(/\/v1beta(?:\/models)?$|\/v1$|\/api\/v3$/u, '')
  return `${root}/${protocol === 'gemini' ? 'v1beta' : protocol === 'ark' ? 'api/v3' : 'v1'}`
}
