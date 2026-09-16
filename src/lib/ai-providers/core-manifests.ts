import { arkProviderManifest } from '@/lib/ai-providers/ark/manifest'
import { elevenLabsProviderManifest } from '@/lib/ai-providers/elevenlabs/manifest'
import { falProviderManifest } from '@/lib/ai-providers/fal/manifest'
import { googleProviderManifest } from '@/lib/ai-providers/google/manifest'
import { metasoProviderManifest } from '@/lib/ai-providers/metaso/manifest'
import { openAiProviderManifest } from '@/lib/ai-providers/openai/manifest'
import { openRouterProviderManifest } from '@/lib/ai-providers/openrouter/manifest'
import { openLuxProviderManifest } from '@/lib/ai-providers/openlux/manifest'
import { yunwuProviderManifest } from '@/lib/ai-providers/yunwu/manifest'
import type { AiProviderManifest } from '@/lib/ai-providers/manifest'

export const CORE_AI_PROVIDER_MANIFESTS = [
  arkProviderManifest,
  elevenLabsProviderManifest,
  falProviderManifest,
  googleProviderManifest,
  metasoProviderManifest,
  openAiProviderManifest,
  openRouterProviderManifest,
  openLuxProviderManifest,
  yunwuProviderManifest,
] as const satisfies readonly AiProviderManifest[]
