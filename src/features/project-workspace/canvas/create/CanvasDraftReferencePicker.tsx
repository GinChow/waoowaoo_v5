'use client'

import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useTranslations } from 'next-intl'
import type { GenerationReferenceRole } from '@/lib/ai-registry/generation-reference-policy'
import GlassModalShell from '@/components/ui/primitives/GlassModalShell'
import { workspaceUploadMediaType } from '@/lib/workspace-resource/upload-client'
import { useWorkspaceResources } from '@/lib/query/hooks/useWorkspaceResources'
import { useWorkspaceResourceView } from '@/lib/query/hooks/useWorkspaceResourceView'
import type { WorkspaceResourceView } from '@/lib/workspace-resource/contracts'
import { CanvasUploadQueue } from '../upload/CanvasUploadQueue'
import { useCanvasUploadQueue } from '../upload/useCanvasUploadQueue'
import { projectWorkspaceResourceCard } from '../projection/workspace-node-resource-projection'
import { canvasDraftReferenceCandidate, canvasDraftReferenceRoles, type CanvasDraftReferenceCandidate, type CanvasGenerationCapability } from './canvas-draft'

/** What the picker needs to know about an already-attached reference: its identity and the role it occupies. */
export type CanvasReferencePickerEntry = GenerationReferenceRole & { readonly resourceId: string }

function candidateFor(resource: WorkspaceResourceView): CanvasDraftReferenceCandidate | null {
  return resource.resourceKind === 'file' ? canvasDraftReferenceCandidate(projectWorkspaceResourceCard(resource)) : null
}

/**
 * Uploads and picker selections both attach canonical project resources to
 * the owner of the edit — a create draft or a "run again" edit of a card.
 */
export function CanvasDraftReferencePicker({ projectId, folderPath, capability, references, onAdd, onUploaded, onBusyChange }: {
  readonly projectId: string
  readonly folderPath: string | null
  readonly capability: CanvasGenerationCapability | null
  readonly references: readonly CanvasReferencePickerEntry[]
  readonly onAdd: (candidate: CanvasDraftReferenceCandidate) => boolean
  readonly onBusyChange: (busy: boolean) => void
  readonly onUploaded: (resourceId: string, reused: boolean) => void
}) {
  const t = useTranslations('projectWorkflow.canvas.workspace.create')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const consumedId = useRef<string | null>(null)
  const query = useWorkspaceResources({ projectId, prefix: null, search: search.trim() || null, scope: 'subtree', enabled: open })
  const pending = useWorkspaceResourceView({ projectId, resourceId: pendingId })
  const queue = useCanvasUploadQueue({ projectId, folderPath, onMaterialized: (_item, id, reused) => {
    onUploaded(id, reused)
    consumedId.current = null
    setPendingId(id)
  } })
  const busy = pendingId !== null || queue.items.some((item) => item.stage === 'uploading' || item.stage === 'materializing')
  useEffect(() => { onBusyChange(busy) }, [busy, onBusyChange])
  const roles: readonly GenerationReferenceRole[] = references
  const allowedTypes = capability ? (['image', 'video', 'audio'] as const).filter((type) => canvasDraftReferenceRoles(capability.mediaType, type, capability, roles).length > 0) : []
  const accept = allowedTypes.map((type) => `${type}/*`).join(',')
  const canAdd = (candidate: CanvasDraftReferenceCandidate) => Boolean(capability
    && !references.some((r) => r.resourceId === candidate.resourceId)
    && canvasDraftReferenceRoles(capability.mediaType, candidate.mediaType, capability, roles).length > 0)

  useEffect(() => {
    if (!pendingId || !pending.data || consumedId.current === pendingId) return
    consumedId.current = pendingId
    const candidate = candidateFor(pending.data)
    const added = candidate ? onAdd(candidate) : false
    setNotice(added ? null : t('referenceRejected'))
    setPendingId(null)
  }, [onAdd, pending.data, pendingId, t])

  const upload = (files: readonly File[]) => {
    if (busy || files.length === 0) return
    if (files.length !== 1) { setNotice(t('uploadOneReference')); return }
    const type = workspaceUploadMediaType(files[0])
    if (!allowedTypes.some((allowed) => allowed === type)) { setNotice(t('referenceRejected')); return }
    setNotice(null)
    queue.addFiles(files, { x: 0, y: 0 })
  }
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    upload(Array.from(event.dataTransfer.files))
  }
  const candidates = query.data?.pages.flatMap((page) => page.items).flatMap((resource) => {
    const candidate = candidateFor(resource)
    return candidate && canAdd(candidate) ? [candidate] : []
  }) ?? []

  return (
    <div data-canvas-reference-zone onKeyDown={(event) => { if (open && event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }} onDrop={drop} onDragOver={(event) => {
      if (event.dataTransfer.types.includes('Files')) {
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'
      }
    }}>
      <input ref={input} type="file" accept={accept} className="hidden" onChange={(event) => {
        upload(Array.from(event.target.files ?? [])); event.target.value = ''
      }} />
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="glass-btn-base glass-btn-secondary px-3 py-2 text-xs" disabled={busy || allowedTypes.length === 0} onClick={() => input.current?.click()}>{t('uploadReference')}</button>
        <button type="button" className="glass-btn-base glass-btn-secondary px-3 py-2 text-xs" disabled={busy || !capability} onClick={() => setOpen(true)}>{t('chooseProjectReference')}</button>
      </div>
      <p className="mt-2 rounded-xl border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500">{t('referencesHint')}</p>
      {busy ? <p role="status" className="mt-2 text-xs text-slate-500">{t('referenceLoading')}</p> : null}
      {notice ? <p role="alert" className="mt-2 text-xs text-red-600">{notice}</p> : null}
      {pending.isError && pendingId ? <button type="button" className="text-xs text-red-600" onClick={() => { setPendingId(null); setNotice(t('referenceReadFailed')) }}>{t('referenceReadFailed')}</button> : null}
      <CanvasUploadQueue items={queue.items} onRetry={(item) => { if (!busy) queue.retry(item) }} onDismiss={queue.dismiss} />
      <GlassModalShell open={open} onClose={() => setOpen(false)} title={t('chooseProjectReference')}>
        <input className="mb-3 w-full rounded-lg border p-2 text-sm" aria-label={t('searchReferences')} placeholder={t('searchReferences')} value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {query.isError ? <p role="alert">{t('referenceReadFailed')}</p> : query.isPending ? <p>{t('referenceLoading')}</p> : candidates.length === 0 ? <p className="text-sm text-slate-500">{t('noCompatibleReferences')}</p> : candidates.map((candidate) => (
            <button key={candidate.resourceId} type="button" className="flex w-full items-center gap-3 rounded-lg border p-2 text-left hover:bg-slate-50" onClick={() => { setNotice(onAdd(candidate) ? null : t('referenceRejected')); setOpen(false) }}>
              {candidate.mediaType === 'image' && candidate.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- Resource previews already use the canonical media route.
                <img src={candidate.previewUrl} alt="" className="h-12 w-12 rounded object-cover" />
              ) : null}
              <span className="min-w-0"><span className="block truncate text-sm">{candidate.name}</span><span className="block truncate text-xs text-slate-500">{candidate.workspacePath}</span></span>
            </button>
          ))}
          {query.hasNextPage ? <button type="button" disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage() }}>{t('loadMoreReferences')}</button> : null}
        </div>
      </GlassModalShell>
    </div>
  )
}
