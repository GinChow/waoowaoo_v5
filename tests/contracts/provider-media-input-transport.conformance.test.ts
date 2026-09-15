import { describe, expect, it } from 'vitest'
import { listRegisteredAiProviderAdapters } from '@/lib/ai-providers'
import {
  listProviderMediaInputContracts,
  resolveEffectiveCapabilitiesByModelKey,
} from '@/lib/ai-exec/media-input-transport'
import { ensureAiCatalogsRegistered } from '@/lib/ai-exec/catalog-bootstrap'
import { listBuiltinCapabilityCatalog } from '@/lib/ai-registry/capabilities-catalog'
import { composeModelKey } from '@/lib/ai-registry/selection'

describe('Provider media input transport registry conformance', () => {
  it('exhaustively binds every media adapter modality to one transport contract', () => {
    const adapters = listRegisteredAiProviderAdapters()
    const adapterModalities = new Set<string>()
    for (const adapter of adapters) {
      if (adapter.languageModel) adapterModalities.add(`${adapter.providerKey}:vision`)
      if (adapter.image) adapterModalities.add(`${adapter.providerKey}:image`)
      if (adapter.video) adapterModalities.add(`${adapter.providerKey}:video`)
    }

    const contracts = listProviderMediaInputContracts()
    const contractModalities = contracts.map((contract) => `${contract.provider}:${contract.modality}`)
    expect(new Set(contractModalities).size).toBe(contractModalities.length)
    expect(new Set(contractModalities)).toEqual(adapterModalities)

    for (const contract of contracts) {
      const transportEntries = Object.entries(contract.transports)
      expect(transportEntries.length).toBeGreaterThan(0)
      for (const [, transports] of transportEntries) {
        expect(transports && transports.length).toBeGreaterThan(0)
        expect(new Set(transports).size).toBe(transports?.length)
      }
    }
  })

  it('projects the same effective media capabilities for every provider instance', () => {
    ensureAiCatalogsRegistered()
    let referenceCapableModels = 0
    for (const entry of listBuiltinCapabilityCatalog()) {
      if (entry.modelType !== 'image' && entry.modelType !== 'video') continue
      const hasReferences = entry.modelType === 'image'
        ? (entry.capabilities?.image?.maxReferenceImages ?? 0) > 0
        : (entry.capabilities?.video?.maxReferenceImages ?? 0) > 0
          || (entry.capabilities?.video?.maxReferenceAudios ?? 0) > 0
          || (entry.capabilities?.video?.maxReferenceVideos ?? 0) > 0
      if (!hasReferences) continue
      referenceCapableModels += 1
      const canonical = resolveEffectiveCapabilitiesByModelKey(
        entry.modelType,
        composeModelKey(entry.provider, entry.modelId),
      )
      const providerInstance = resolveEffectiveCapabilitiesByModelKey(
        entry.modelType,
        composeModelKey(`${entry.provider}:secondary`, entry.modelId),
      )
      expect(providerInstance).toEqual(canonical)
    }
    expect(referenceCapableModels).toBeGreaterThan(0)
  })
})
