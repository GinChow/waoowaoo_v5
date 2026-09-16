'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { AppIcon, type AppIconName } from '@/components/ui/icons'
import { useClientErrorMessage } from '@/hooks/useClientErrorMessage'
import { useWorkspaceResourceView } from '@/lib/query/hooks'
import {
  workspaceResourceContentText,
  type WorkspaceResourceInputSummary,
  type WorkspaceResourceMediaType,
} from '@/lib/workspace-resource/contracts'
import {
  applyWorkspaceResourceRegenerationEdits,
  readWorkspaceResourceRegenerationTemplate,
  type WorkspaceResourceRegenerationReference,
} from '@/lib/workspace-resource/regeneration'
import { useWorkspaceProvider } from '../../WorkspaceProvider'
import { workspaceCanvasScrollableRegionProps } from '../canvas-scroll-lock'
import { PreviewableImage, SELECTABLE_TEXT_CLASS } from '../nodes/renderers/renderer-shared'
import type { WorkspaceNodeDetailsActions } from './WorkspaceNodeDetailsCard'
import type {
  WorkspaceCanvasBillableOperationView,
  WorkspaceResourceCardView,
} from '../contracts/workspace-canvas-interactions'
import { WorkspaceNodeActionBar } from './WorkspaceNodeActionBar'
import { WorkspaceNodeGenerationEditor, WorkspaceNodePromptReadout, type WorkspaceNodeAddedReference } from './WorkspaceNodeGenerationEditor'
import { useWorkspaceNodeGenerationEdits } from './useWorkspaceNodeGenerationEdits'
import { regenerationReferenceForCandidate, type CanvasDraftReferenceCandidate } from '../create/canvas-draft'
import { canvasGenerationCapabilityFor } from '../hooks/useCanvasCreateDraft'

/** Media-family icon for tiles that have no visual thumbnail of their own. */
const INPUT_MEDIA_ICONS: Record<WorkspaceResourceMediaType, AppIconName> = {
  image: 'image',
  video: 'video',
  audio: 'audioWave',
  text: 'fileText',
}

const TILE_BOX_CLASS = 'relative h-[76px] w-[76px] overflow-hidden rounded-[12px] bg-white'

function inputKey(input: WorkspaceResourceInputSummary): string {
  return `${input.role}:${String(input.position)}:${input.resourceId}`
}

function SectionShell({
  title,
  trailing,
  children,
}: {
  readonly title: string
  readonly trailing?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <section className="rounded-[16px] bg-slate-50 p-3 ring-1 ring-slate-100">
      <div className="flex items-baseline justify-between gap-3">
        <p className={`${SELECTABLE_TEXT_CLASS} shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--glass-text-tertiary)]`}>
          {title}
        </p>
        {trailing}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  )
}

/**
 * Shared tile chrome: a square media box with the resolved input name below.
 * Tiles pack horizontally so a whole reference set stays readable in one or two
 * rows instead of one full-width row per input.
 */
interface InputTileEdit {
  /** True while the reference is part of the edited request; false once removed. */
  readonly included: boolean
  readonly toggleLabel: string
  readonly onToggle: () => void
}

function InputTile({
  name,
  title,
  actionLabel,
  highlighted,
  onAction,
  edit,
  children,
}: {
  readonly name: string
  readonly title: string
  readonly actionLabel: string | null
  readonly highlighted: boolean
  readonly onAction: (() => void) | null
  readonly edit?: InputTileEdit
  readonly children: ReactNode
}) {
  const ringClass = highlighted ? 'ring-2 ring-slate-500' : 'ring-1 ring-slate-200'
  const removed = edit ? !edit.included : false
  return (
    <li className={`relative w-[76px] shrink-0 ${removed ? 'opacity-45' : ''}`}>
      {edit ? (
        <button
          type="button"
          aria-label={edit.toggleLabel}
          title={edit.toggleLabel}
          className="nodrag absolute -right-1.5 -top-1.5 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-[var(--glass-text-secondary)] shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-100 hover:text-[var(--glass-text-primary)]"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            edit.onToggle()
          }}
        >
          <AppIcon name={removed ? 'plus' : 'close'} className="h-3 w-3" />
        </button>
      ) : null}
      {onAction && actionLabel ? (
        <button
          type="button"
          title={`${title} · ${actionLabel}`}
          aria-label={`${title} · ${actionLabel}`}
          className={`nodrag block border-0 p-0 ${TILE_BOX_CLASS} ${ringClass}`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onAction()
          }}
        >
          {children}
        </button>
      ) : (
        <div className={`${TILE_BOX_CLASS} ${ringClass}`} title={title}>
          {children}
        </div>
      )}
      <p
        className={`${SELECTABLE_TEXT_CLASS} mt-1 truncate text-center text-[10px] leading-4 text-[var(--glass-text-secondary)]`}
        title={name}
      >
        {name}
      </p>
    </li>
  )
}

/** Small media-family marker, kept in the corner so it never sits under a control. */
function MediaTypeBadge({ mediaType }: { readonly mediaType: WorkspaceResourceMediaType }) {
  return (
    <span className="absolute left-1 top-1 inline-flex h-4 w-4 items-center justify-center rounded-[6px] bg-white/85 text-[var(--glass-text-tertiary)] shadow-sm">
      <AppIcon name={INPUT_MEDIA_ICONS[mediaType]} className="h-2.5 w-2.5" />
    </span>
  )
}

/**
 * Audio references play in place: the tile itself is the play/pause control,
 * with the media-family badge in the corner and a progress strip at the bottom.
 * Only the input marked active by the panel plays, so two references can never
 * sound at once.
 */
function AudioInputTile({
  input,
  mediaUrl,
  mediaTypeLabel,
  isPlaying,
  playLabel,
  pauseLabel,
  onToggle,
  onPlaybackStopped,
  edit,
}: {
  readonly input: WorkspaceResourceInputSummary
  readonly mediaUrl: string
  readonly mediaTypeLabel: string
  readonly isPlaying: boolean
  readonly playLabel: string
  readonly pauseLabel: string
  readonly onToggle: () => void
  readonly onPlaybackStopped: () => void
  readonly edit?: InputTileEdit
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playbackStoppedRef = useRef(onPlaybackStopped)
  useLayoutEffect(() => { playbackStoppedRef.current = onPlaybackStopped }, [onPlaybackStopped])
  const [progressRatio, setProgressRatio] = useState(0)

  useEffect(() => {
    const element = audioRef.current
    if (!element) return
    if (!isPlaying) {
      element.pause()
      return
    }
    // A blocked play() must not leave the tile claiming it is playing.
    void element.play().catch(() => playbackStoppedRef.current())
  }, [isPlaying])

  return (
    <InputTile
      name={input.name}
      title={`${input.name} · ${mediaTypeLabel}`}
      actionLabel={isPlaying ? pauseLabel : playLabel}
      highlighted={isPlaying}
      onAction={onToggle}
      edit={edit}
    >
      <span className="flex h-full w-full items-center justify-center bg-slate-50">
        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full shadow-sm ring-1 ${isPlaying ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-[var(--glass-text-secondary)] ring-slate-200'}`}>
          <AppIcon name={isPlaying ? 'pause' : 'play'} className="h-4 w-4" />
        </span>
      </span>
      <MediaTypeBadge mediaType="audio" />
      {progressRatio > 0 ? (
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-slate-200">
          <span
            className="block h-full bg-slate-900"
            style={{ width: `${String(Math.min(100, progressRatio * 100))}%` }}
          />
        </span>
      ) : null}
      <audio
        ref={audioRef}
        src={mediaUrl}
        preload="metadata"
        className="hidden"
        onTimeUpdate={(event) => {
          const element = event.currentTarget
          setProgressRatio(element.duration > 0 ? element.currentTime / element.duration : 0)
        }}
        onEnded={() => {
          setProgressRatio(0)
          onPlaybackStopped()
        }}
      />
    </InputTile>
  )
}

/** Video references open in the player slot: 76px is too small to watch. */
function VideoInputTile({
  input,
  mediaUrl,
  mediaTypeLabel,
  isActive,
  playLabel,
  onOpen,
  edit,
}: {
  readonly input: WorkspaceResourceInputSummary
  readonly mediaUrl: string
  readonly mediaTypeLabel: string
  readonly isActive: boolean
  readonly playLabel: string
  readonly onOpen: () => void
  readonly edit?: InputTileEdit
}) {
  return (
    <InputTile
      name={input.name}
      title={`${input.name} · ${mediaTypeLabel}`}
      actionLabel={playLabel}
      highlighted={isActive}
      onAction={onOpen}
      edit={edit}
    >
      <video
        // The media fragment forces browsers to paint a poster frame instead of
        // an empty box; playback itself happens in the player slot below.
        src={`${mediaUrl}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        className="pointer-events-none h-full w-full bg-slate-900 object-cover"
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-900/55 text-white">
          <AppIcon name="play" className="h-4 w-4" />
        </span>
      </span>
      <MediaTypeBadge mediaType="video" />
    </InputTile>
  )
}

/** The single video viewport, shared by every video reference in the card. */
function VideoPlayerSlot({
  input,
  mediaUrl,
  mediaTypeLabel,
  closeLabel,
  onClose,
}: {
  readonly input: WorkspaceResourceInputSummary
  readonly mediaUrl: string
  readonly mediaTypeLabel: string
  readonly closeLabel: string
  readonly onClose: () => void
}) {
  return (
    <div className="mt-2 flex items-center gap-3 rounded-[12px] bg-white p-2 ring-1 ring-slate-200">
      <video
        src={mediaUrl}
        aria-label={input.name}
        controls
        autoPlay
        preload="metadata"
        className="nodrag nowheel h-[126px] w-[224px] shrink-0 rounded-[10px] bg-black object-contain"
      />
      <div className="min-w-0 flex-1">
        <p className={`${SELECTABLE_TEXT_CLASS} truncate text-xs font-semibold text-[var(--glass-text-primary)]`}>
          {input.name}
        </p>
        <p className={`${SELECTABLE_TEXT_CLASS} mt-0.5 text-[11px] text-[var(--glass-text-tertiary)]`}>
          {mediaTypeLabel}
        </p>
      </div>
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        className="nodrag shrink-0 rounded-full p-1 text-[var(--glass-text-tertiary)] hover:bg-slate-100"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <AppIcon name="close" className="h-4 w-4" />
      </button>
    </div>
  )
}

/**
 * The presentational body of the selected node's detail card: input resources
 * packed horizontally on top, generation prompt below. It is the single
 * rendering of this View — the Canvas card and the layout lab both use it.
 */
export function WorkspaceNodeDetailsPanel({
  card,
  prompt,
  modelName,
  inputs,
  actions,
}: {
  readonly card: WorkspaceResourceCardView
  readonly prompt: string | null
  readonly modelName: string | null
  readonly inputs: readonly WorkspaceResourceInputSummary[]
  readonly actions: WorkspaceNodeDetailsActions
}) {
  const t = useTranslations('projectWorkflow.canvas.workspace.details')
  const labels = useTranslations('projectWorkflow.canvas.workspace.nodeFields')
  const mediaTypeLabels = useTranslations('projectWorkflow.canvas.workspace.nodes.resourceCard.mediaType')
  const common = useTranslations('common')
  const errorLabels = useTranslations('projectWorkflow.canvas.workspace.errors')
  const resolveClientError = useClientErrorMessage()
  const { projectId } = useWorkspaceProvider()
  // "Run again" is offered only when the server projected the exact Operation
  // input for this card; the editor reads and edits that template in place.
  const regenerateOperation = card.canvasOperations.find(
    (operation): operation is WorkspaceCanvasBillableOperationView => operation.kind === 'regenerate',
  ) ?? null
  const regenerationTemplate = useMemo(
    () => (regenerateOperation ? readWorkspaceResourceRegenerationTemplate(regenerateOperation.input) : null),
    [regenerateOperation],
  )
  const generationCapability = regenerationTemplate
    ? canvasGenerationCapabilityFor(actions.generationCapabilities, regenerationTemplate.mediaType, 'manual')
    : null
  const editor = useWorkspaceNodeGenerationEdits(regenerationTemplate, generationCapability, inputs)
  const referenceOf = (input: WorkspaceResourceInputSummary): WorkspaceResourceRegenerationReference => ({
    resourceId: input.resourceId,
    contentVersion: input.contentVersion,
    durationMs: input.durationMs,
    role: input.role,
    channel: input.mediaType === 'text' ? 'context' : input.mediaType,
  })
  const tileEdit = (input: WorkspaceResourceInputSummary): InputTileEdit | undefined => {
    if (!regenerationTemplate) return undefined
    const reference = referenceOf(input)
    const included = editor.hasReference(reference)
    return {
      included,
      toggleLabel: included
        ? t('editor.removeReference', { name: input.name })
        : t('editor.restoreReference', { name: input.name }),
      onToggle: () => (included ? editor.removeReference(reference) : editor.addReference(reference)),
    }
  }
  const regenerate = regenerateOperation
    ? () => actions.onRegenerate(
        regenerateOperation,
        applyWorkspaceResourceRegenerationEdits(regenerateOperation.input, editor.edits, editor.configurationVersion),
      )
    : null
  // Cards dropped on this panel, uploads and project picks all join the edit's
  // references with the role this generation kind allows.
  const { referenceDrop, onReferenceDropConsumed } = actions
  const { addReference: addEditReference, references: editReferences } = editor
  const attachCandidate = useCallback((candidate: CanvasDraftReferenceCandidate) => {
    if (!regenerationTemplate) return false
    const reference = regenerationReferenceForCandidate(
      regenerationTemplate.mediaType,
      candidate,
      editReferences,
      generationCapability,
    )
    if (!reference) return false
    addEditReference(reference, candidate)
    return true
  }, [addEditReference, editReferences, generationCapability, regenerationTemplate])
  useEffect(() => {
    if (!referenceDrop) return
    onReferenceDropConsumed(referenceDrop.requestId)
    attachCandidate(referenceDrop.candidate)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The drop is consumed once against the references at that moment.
  }, [onReferenceDropConsumed, referenceDrop])
  // The picker reports the rejection itself when no role is left for the candidate.
  const [referencesBusy, setReferencesBusy] = useState(false)
  const addedReferences: readonly WorkspaceNodeAddedReference[] = regenerationTemplate
    ? editor.references
      .filter((reference) => !inputs.some((input) => (
        input.resourceId === reference.resourceId
        && input.contentVersion === reference.contentVersion
        && input.role === reference.role
      )))
      .map((reference) => ({ reference, candidate: editor.attachedCandidateFor(reference) }))
    : []
  // Text/structured resources load their full content through the single
  // single-resource read route; tree summaries stay bounded (WR-13).
  const isTextResource = card.resource.mediaType === 'text' && card.resource.status === 'ready'
  const contentQuery = useWorkspaceResourceView({
    projectId,
    resourceId: isTextResource ? card.resource.resourceId : null,
  })
  const fullContentText = workspaceResourceContentText(contentQuery.data?.current?.content)
  // One active playback across the whole card: starting a video stops the
  // playing audio tile and vice versa.
  const [activeInputKey, setActiveInputKey] = useState<string | null>(null)
  const activeInput = inputs.find((input) => inputKey(input) === activeInputKey) ?? null
  const activeVideoUrl = activeInput?.mediaType === 'video' ? activeInput.previewUrl : null
  const failedErrorHeadline = card.resource.error?.code
    ? resolveClientError(new Error(card.resource.error.code), errorLabels('unknown'))
    : card.resource.status === 'failed'
      ? errorLabels('unknown')
      : null
  const failedErrorDiagnostic = card.resource.error?.diagnostic?.trim() || null

  const downloadView = card.download
  const download = downloadView
    ? () => {
        const anchor = document.createElement('a')
        anchor.href = downloadView.href
        anchor.download = downloadView.fileName
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      }
    : null

  return (
    <section className="space-y-2.5 rounded-[20px] border border-slate-200 bg-white/96 p-4 shadow-[0_18px_48px_rgba(15,23,42,0.14)] backdrop-blur-xl">
      {isTextResource ? (
        <SectionShell title={t('contentSection')}>
          {fullContentText !== null ? (
            <pre
              {...workspaceCanvasScrollableRegionProps<HTMLPreElement>()}
              className={`${SELECTABLE_TEXT_CLASS} nowheel max-h-[16rem] overflow-y-auto whitespace-pre-wrap text-[13px] leading-6 text-slate-700`}
            >
              {fullContentText}
            </pre>
          ) : contentQuery.isError ? (
            <div className="flex items-center gap-3 text-xs text-[var(--glass-text-secondary)]">
              <span>{t('contentLoadFailed')}</span>
              <button
                type="button"
                className="font-semibold text-[var(--glass-text-primary)]"
                onClick={() => { void contentQuery.refetch() }}
              >
                {t('contentRetry')}
              </button>
            </div>
          ) : (
            <span className="text-xs text-[var(--glass-text-tertiary)]">{t('contentLoading')}</span>
          )}
        </SectionShell>
      ) : null}
      {inputs.length > 0 ? (
        <SectionShell
          title={labels('generationReferences')}
          trailing={(
            <span className={`${SELECTABLE_TEXT_CLASS} shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--glass-text-tertiary)] ring-1 ring-slate-200`}>
              {inputs.length}
            </span>
          )}
        >
          <ul
            {...workspaceCanvasScrollableRegionProps<HTMLUListElement>()}
            className="nowheel flex max-h-[15rem] flex-wrap gap-2 overflow-y-auto"
          >
            {inputs.map((input) => {
              const key = inputKey(input)
              const mediaTypeLabel = mediaTypeLabels(input.mediaType)
              const mediaUrl = input.previewUrl
              if (mediaUrl && input.mediaType === 'audio') {
                return (
                  <AudioInputTile
                    key={key}
                    input={input}
                    mediaUrl={mediaUrl}
                    mediaTypeLabel={mediaTypeLabel}
                    isPlaying={key === activeInputKey}
                    playLabel={common('play')}
                    pauseLabel={common('pause')}
                    onToggle={() => setActiveInputKey((current) => (current === key ? null : key))}
                    onPlaybackStopped={() => setActiveInputKey((current) => (current === key ? null : current))}
                    edit={tileEdit(input)}
                  />
                )
              }
              if (mediaUrl && input.mediaType === 'video') {
                return (
                  <VideoInputTile
                    key={key}
                    input={input}
                    mediaUrl={mediaUrl}
                    mediaTypeLabel={mediaTypeLabel}
                    isActive={key === activeInputKey}
                    playLabel={common('play')}
                    onOpen={() => setActiveInputKey(key)}
                    edit={tileEdit(input)}
                  />
                )
              }
              return (
                <InputTile
                  key={key}
                  name={input.name}
                  title={`${input.name} · ${mediaTypeLabel}`}
                  actionLabel={null}
                  highlighted={false}
                  onAction={null}
                  edit={tileEdit(input)}
                >
                  {mediaUrl && input.mediaType === 'image' ? (
                    <PreviewableImage
                      sourceImageUrl={mediaUrl}
                      alt={input.name}
                      buttonClassName="h-full w-full"
                      imageClassName="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-[var(--glass-text-tertiary)]">
                      <AppIcon name={INPUT_MEDIA_ICONS[input.mediaType]} className="h-5 w-5" />
                    </span>
                  )}
                </InputTile>
              )
            })}
          </ul>
          {activeInput && activeVideoUrl ? (
            <VideoPlayerSlot
              input={activeInput}
              mediaUrl={activeVideoUrl}
              mediaTypeLabel={mediaTypeLabels(activeInput.mediaType)}
              closeLabel={common('close')}
              onClose={() => setActiveInputKey(null)}
            />
          ) : null}
        </SectionShell>
      ) : null}

      {regenerationTemplate ? (
        <WorkspaceNodeGenerationEditor
          template={regenerationTemplate}
          editor={editor}
          capability={generationCapability}
          modelName={modelName}
          disabled={actions.busy}
          dropHighlighted={actions.dropHighlighted}
          addedReferences={addedReferences}
          referencePicker={{
            projectId,
            folderPath: actions.folderPath,
            onAdd: attachCandidate,
            onUploaded: actions.onUploadedReference,
            onBusyChange: setReferencesBusy,
          }}
        />
      ) : prompt ? (
        <WorkspaceNodePromptReadout prompt={prompt} modelName={modelName} />
      ) : modelName ? (
        <SectionShell title={labels('generationModel')}>
          <p className={`${SELECTABLE_TEXT_CLASS} break-all text-xs text-slate-700`}>{modelName}</p>
        </SectionShell>
      ) : null}

      {!prompt && !modelName && inputs.length === 0 && !isTextResource ? (
        <p className={`${SELECTABLE_TEXT_CLASS} px-1 py-2 text-xs text-[var(--glass-text-tertiary)]`}>
          {t('empty')}
        </p>
      ) : null}

      {failedErrorHeadline ? (
        <div className="rounded-xl bg-[var(--glass-tone-danger-bg)] px-3 py-2 text-xs leading-5 text-[var(--glass-tone-danger-fg)] shadow-[var(--glass-tone-shadow)]">
          <div>{failedErrorHeadline}</div>
          {failedErrorDiagnostic ? (
            <div className="mt-0.5 break-words text-[11px] opacity-70">
              {errorLabels('providerDiagnostic', { message: failedErrorDiagnostic })}
            </div>
          ) : null}
        </div>
      ) : null}

      <WorkspaceNodeActionBar
        card={card}
        busy={actions.busy}
        onDiscuss={() => actions.onAssistantPrefill(null)}
        onDownload={download}
        onPreview={actions.onPreview}
        onRegenerate={regenerate}
        regenerateDisabled={!editor.valid || generationCapability === null || referencesBusy}
        onAnimate={actions.onAnimate}
        onUseAsReference={actions.onUseAsReference}
        onOperation={actions.onOperation}
      />
    </section>
  )
}
