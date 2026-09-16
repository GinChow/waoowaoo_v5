'use client'

import { useState } from 'react'
import { ViewportPortal, useInternalNode } from '@xyflow/react'
import ImagePreviewModal from '@/components/ui/ImagePreviewModal'
import type { WorkspaceCanvasFlowNode } from '../node-canvas-types'
import { WorkspaceNodeImagePreviewContext } from '../nodes/renderers/renderer-shared'
import { WorkspaceNodeDetailsPanel } from './WorkspaceNodeDetailsPanel'
import type {
  WorkspaceCanvasBillableOperationView,
  WorkspaceCanvasResourceOperationView,
} from '../contracts/workspace-canvas-interactions'
import type { WorkspaceResourceJsonObject } from '@/lib/workspace-resource/contracts'
import type { CanvasDraftReferenceCandidate } from '../create/canvas-draft'
import type { WorkspaceCanvasGenerationCapabilitiesView } from '@/lib/workspace-resource/canvas-generation-capabilities'

/** A card dropped onto the details panel, to be attached as an edit reference once. */
export interface WorkspaceNodeReferenceDropRequest {
  readonly requestId: string
  readonly candidate: CanvasDraftReferenceCandidate
}

const DETAILS_CARD_GAP = 16
/**
 * The card is deliberately wider than a node: input references pack
 * horizontally and the prompt gets long lines, so the same content needs far
 * less vertical space than the node-width column it replaced.
 */
const DETAILS_CARD_MIN_WIDTH = 720

/**
 * The detail card for the selected Canvas node, rendered in the ReactFlow
 * viewport layer directly below the node so it follows canvas pan/zoom.
 * It only consumes the card View (prompt provenance + resolved input
 * summaries); it never fetches by raw resource ID.
 */
export interface WorkspaceNodeDetailsActions {
  readonly busy: boolean
  readonly onAssistantPrefill: (text: string | null) => void
  readonly onPreview: () => void
  readonly onOperation: (operation: WorkspaceCanvasResourceOperationView) => void
  /**
   * "Run again" with the edited input: the server-projected Operation plus
   * the exact batch input the editor derived from its template.
   */
  readonly onRegenerate: (
    operation: WorkspaceCanvasBillableOperationView,
    input: WorkspaceResourceJsonObject,
  ) => void
  readonly onAnimate: (() => void) | null
  readonly onUseAsReference: (() => void) | null
  /** True while a dragged card hovers the panel as a reference drop. */
  readonly dropHighlighted: boolean
  readonly referenceDrop: WorkspaceNodeReferenceDropRequest | null
  readonly onReferenceDropConsumed: (requestId: string) => void
  /** Folder a reference uploaded from the panel lands in (the Canvas' current folder). */
  readonly folderPath: string | null
  /** A reference uploaded from the panel materialized; the Canvas places its card beside the selected node. */
  readonly onUploadedReference: (resourceId: string, reused: boolean) => void
  /** Configured model capabilities; null while loading or when unavailable. */
  readonly generationCapabilities: WorkspaceCanvasGenerationCapabilitiesView | null
}

export function WorkspaceNodeDetailsCard({
  node,
  actions,
}: {
  readonly node: WorkspaceCanvasFlowNode
  readonly actions: WorkspaceNodeDetailsActions
}) {
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)
  // Section members carry parent-relative positions; the viewport-layer card
  // must anchor to the node's absolute canvas position.
  const internalNode = useInternalNode(node.id)
  if (node.data.kind !== 'resourceCard') return null
  const resource = node.data.resourceDetails.resource
  const prompt = resource.prompt
  const modelName = resource.modelName
  const inputs = node.data.resourceDetails.inputSummaries
  const width = Math.max(node.data.width, DETAILS_CARD_MIN_WIDTH)
  const anchor = internalNode?.internals.positionAbsolute ?? node.position

  return (
    <WorkspaceNodeImagePreviewContext.Provider value={setPreviewImageUrl}>
      <ViewportPortal>
        <div
          className="nodrag nopan pointer-events-auto absolute"
          style={{
            transform: `translate(${anchor.x - (width - node.data.width) / 2}px, ${anchor.y + node.data.height + DETAILS_CARD_GAP}px)`,
            width,
            zIndex: 40,
          }}
          data-node-details-for={node.id}
          onClick={(event) => event.stopPropagation()}
          onMouseDownCapture={(event) => event.stopPropagation()}
        >
          <WorkspaceNodeDetailsPanel
            key={resource.resourceId}
            card={node.data.resourceDetails}
            prompt={prompt}
            modelName={modelName}
            inputs={inputs}
            actions={actions}
          />
        </div>
      </ViewportPortal>
      {previewImageUrl ? (
        <ImagePreviewModal imageUrl={previewImageUrl} onClose={() => setPreviewImageUrl(null)} />
      ) : null}
    </WorkspaceNodeImagePreviewContext.Provider>
  )
}
