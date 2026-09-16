'use client'

import { canvasGenerationFormIssues, canvasEditableParameters } from '../create/canvas-generation-form'
import { canvasReferenceIssue, type CanvasDraftReferenceCandidate, type CanvasGenerationCapability } from '../create/canvas-draft'

import { useCallback, useMemo, useState } from 'react'
import type { WorkspaceResourceInputSummary } from '@/lib/workspace-resource/contracts'
import type {
  WorkspaceResourceRegenerationEdits,
  WorkspaceResourceRegenerationParameters,
  WorkspaceResourceRegenerationReference,
  WorkspaceResourceRegenerationTemplate,
} from '@/lib/workspace-resource/regeneration'

function referenceKey(reference: WorkspaceResourceRegenerationReference): string {
  return `${reference.resourceId}:${String(reference.contentVersion)}:${reference.role}`
}

function sameReferences(
  left: readonly WorkspaceResourceRegenerationReference[],
  right: readonly WorkspaceResourceRegenerationReference[],
): boolean {
  return left.length === right.length
    && left.every((reference, index) => referenceKey(reference) === referenceKey(right[index]))
}

/**
 * Local edit state over a server-projected "run again" template. The caller
 * keys the owning component by Resource identity, so a new selection starts
 * from that Resource's frozen facts instead of carrying edits across cards.
 */
export function useWorkspaceNodeGenerationEdits(template: WorkspaceResourceRegenerationTemplate | null, capability: CanvasGenerationCapability | null, inputSummaries: readonly WorkspaceResourceInputSummary[]) {
  const [configurationVersion, setConfigurationVersion] = useState(capability?.view.configurationVersion ?? null)
  const [prompt, setPrompt] = useState(template?.prompt ?? '')
  const [name, setName] = useState('')
  const [aspectRatio, setAspectRatio] = useState<string | null>(template?.aspectRatio ?? null)
  const [durationSeconds, setDurationSeconds] = useState<number | null>(template?.durationSeconds ?? null)
  const [parameters, setParameters] = useState<WorkspaceResourceRegenerationParameters>(template?.parameters ?? {})
  const [references, setReferences] = useState<readonly WorkspaceResourceRegenerationReference[]>(() => (template?.references ?? []).map((reference) => ({ ...reference, durationMs: inputSummaries.find((input) => input.resourceId === reference.resourceId && input.contentVersion === reference.contentVersion)?.durationMs ?? null })))
  const setParameter = useCallback((field: string, value: string | number | boolean | undefined) => {
    setParameters((current) => {
      const next: Record<string, string | number | boolean> = { ...current }
      if (value === undefined) delete next[field]
      else next[field] = value
      return next
    })
  }, [])

  const removeReference = useCallback((reference: WorkspaceResourceRegenerationReference) => {
    const key = referenceKey(reference)
    setReferences((current) => current.filter((candidate) => referenceKey(candidate) !== key))
  }, [])
  // What each attached reference was attached from (name, thumbnail): the
  // regeneration reference only carries identity, the chip needs the rest.
  const [attachedCandidates, setAttachedCandidates] = useState<ReadonlyMap<string, CanvasDraftReferenceCandidate>>(() => new Map())
  const addReference = useCallback((reference: WorkspaceResourceRegenerationReference, candidate?: CanvasDraftReferenceCandidate) => {
    const key = referenceKey(reference)
    setReferences((current) => (
      current.some((candidate) => referenceKey(candidate) === key) || canvasReferenceIssue(capability, [...current, reference]) ? current : [...current, reference]
    ))
    if (candidate) setAttachedCandidates((current) => new Map(current).set(key, candidate))
  }, [capability])
  const attachedCandidateFor = useCallback(
    (reference: WorkspaceResourceRegenerationReference) => attachedCandidates.get(referenceKey(reference)) ?? null,
    [attachedCandidates],
  )
  const hasReference = useCallback(
    (reference: WorkspaceResourceRegenerationReference) => references.some(
      (candidate) => referenceKey(candidate) === referenceKey(reference),
    ),
    [references],
  )

  const edits = useMemo<WorkspaceResourceRegenerationEdits>(() => ({
    name: name.trim(),
    prompt: prompt.trim(),
    aspectRatio,
    parameters: canvasEditableParameters(capability, parameters),
    durationSeconds,
    references,
  }), [aspectRatio, capability, durationSeconds, name, parameters, prompt, references])
  const dirty = template !== null && (
    edits.prompt !== template.prompt.trim()
    || edits.aspectRatio !== template.aspectRatio
    || edits.durationSeconds !== template.durationSeconds
    || JSON.stringify(edits.parameters) !== JSON.stringify(template.parameters)
    || !sameReferences(edits.references, template.references)
  )
  const issues = canvasGenerationFormIssues(capability, { ...edits, configurationVersion, aspectRatioLocked: template?.aspectRatioLocked ?? false })
  const valid = template !== null && edits.name.length > 0 && edits.name !== template.name
    && edits.prompt.length > 0 && issues.length === 0
  const reviewConfiguration = () => {
    if (!capability) return
    setConfigurationVersion(capability.view.configurationVersion)
    setParameters(canvasEditableParameters(capability, parameters))
  }

  return {
    edits,
    configurationVersion,
    issues,
    reviewConfiguration,
    dirty,
    valid,
    prompt,
    setPrompt,
    name,
    setName,
    aspectRatio,
    setAspectRatio,
    durationSeconds,
    setDurationSeconds,
    parameters,
    setParameter,
    references,
    hasReference,
    removeReference,
    addReference,
    attachedCandidateFor,
  } as const
}
