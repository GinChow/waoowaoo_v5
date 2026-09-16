// Metaso relays the MiniMax v2 video protocol unchanged under this prefix
// (verified 2026-09-16 with test_api/src/metaso-minimax-h3.ts). The official
// paths (/v2/video_generation, /v2/query/video_generation/{id}) hang off it.
export const METASO_DEFAULT_BASE_URL = 'https://metaso.cn/api/minimax'

export function resolveMetasoBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl?.trim() || METASO_DEFAULT_BASE_URL).replace(/\/+$/u, '')
}
