'use client'

import { canvasReferenceRole } from './create/canvas-draft'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, WheelEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  type NodeMouseHandler,
  type OnNodeDrag,
  type Viewport,
  useReactFlow,
} from '@xyflow/react'
import { useTranslations } from 'next-intl'
import { logWarn as _ulogWarn } from '@/lib/logging/core'
import type { CanvasNodeLayout } from '@/lib/project-canvas/layout/canvas-layout.types'
import {
  useCanvasGenerationCapabilities,
  useProjectData,
  useWorkspaceResourceByPath,
  useWorkspaceResources,
} from '@/lib/query/hooks'
import { useTaskTargetStateMap } from '@/lib/query/hooks/useTaskTargetStateMap'
import {
  WORKSPACE_RESOURCE_ROOT_FOLDER_KEY,
  isWorkspaceResourceSubtreePath,
  type WorkspaceResourceAncestorView,
  type WorkspaceResourceView,
} from '@/lib/workspace-resource/contracts'
import { useWorkspaceProvider } from '../WorkspaceProvider'
import type {
  WorkspaceAssistantActiveFocusRequest,
  WorkspaceAssistantTurnOutcomeView,
} from '../workspace-assistant-focus'
import { useCanvasLayoutPersistence } from './hooks/useCanvasLayoutPersistence'
import { vacantCanvasPosition } from './layout/vacant-position'
import { buildWorkspaceNodeCanvasProjection, useWorkspaceNodeCanvasProjection } from './hooks/useWorkspaceNodeCanvasProjection'
import { resolveWorkspaceCanvasFocusNodeIds, useCanvasFocusFollow } from './hooks/useCanvasFocusFollow'
import { buildWorkspaceCanvasLayoutInput } from './canvasLayoutInput'
import {
  buildWorkspaceCanvasEdgeSignature,
  buildWorkspaceCanvasNodeSignature,
} from './hooks/canvas-projection-signature'
import {
  DEFAULT_WORKSPACE_CANVAS_VIEWPORT,
  getNextWorkspaceCanvasWheelZoom,
  WORKSPACE_CANVAS_MAX_ZOOM,
  WORKSPACE_CANVAS_MIN_ZOOM,
} from './canvasViewport'
import { isWorkspaceCanvasWheelLockedTarget } from './canvas-scroll-lock'
import { WorkspaceNodeDetailsCard } from './details/WorkspaceNodeDetailsCard'
import { workspaceNodeTypes } from './nodes/workspaceNodeTypes'
import { WorkspaceCanvasResourceSelectionContext } from './nodes/workspace-node-selection'
import {
  WorkspaceCanvasFolderActionsContext,
  type WorkspaceCanvasFolderOpenTarget,
} from './nodes/renderers/folder-card'
import type { WorkspaceCanvasFlowEdge, WorkspaceCanvasFlowNode } from './node-canvas-types'
import type { WorkspaceCanvasFolderNodeData, WorkspaceCanvasNodeRecord } from './node-canvas-types'
import { collectWorkspaceNodeRuntimeTargets, resolveWorkspaceCanvasNodeData } from './workspace-node-runtime'
import type {
  WorkspaceAssistantDraftRequest,
  WorkspaceCanvasBillableOperationView,
  WorkspaceCanvasPathFocusRequest,
  WorkspaceCanvasResourceOperationView,
  WorkspaceCanvasSelection,
  WorkspaceResourceCardMemberView,
} from './contracts/workspace-canvas-interactions'
import { workspaceResourceParentPath, type WorkspaceResourceJsonObject } from '@/lib/workspace-resource/contracts'
import { readWorkspaceResourceOperationOutputResources } from '@/lib/workspace-resource/operation-output'
import { useCanvasOperationAction } from './actions/useCanvasOperationAction'
import { useCanvasResourceDeleteAction, type CanvasResourceDeleteTarget } from './actions/useCanvasResourceDeleteAction'
import { useCanvasResourceRestoreAction } from './actions/useCanvasResourceRestoreAction'
import { useCanvasHistory } from './hooks/useCanvasHistory'
import { useCanvasMultiSelection } from './hooks/useCanvasMultiSelection'
import { isWorkspaceCanvasEditableTarget } from './canvas-interaction-target'
import { CanvasOperationConfirmationModal } from './actions/CanvasOperationConfirmationModal'
import { WorkspaceResourcePreviewModal } from './preview/WorkspaceResourcePreviewModal'
import { workspaceNodeId } from './workspace-canvas-node-ids'
import { useCanvasUploadQueue, type CanvasUploadQueueItem } from './upload/useCanvasUploadQueue'
import { CanvasUploadQueue } from './upload/CanvasUploadQueue'
import { WorkspaceCanvasCreateMenu } from './create/WorkspaceCanvasCreateMenu'
import { WorkspaceCanvasDraftCard } from './create/WorkspaceCanvasDraftCard'
import {
  buildCanvasDraftMessage,
  canvasDraftReferenceCandidate,
  canvasDraftReferenceRoles,
  type CanvasDraftComposition,
} from './create/canvas-draft'
import { canvasGenerationCapabilityFor, useCanvasCreateDraft } from './hooks/useCanvasCreateDraft'
import { useCanvasReferenceDrop } from './hooks/useCanvasReferenceDrop'
import type { WorkspaceNodeReferenceDropRequest } from './details/WorkspaceNodeDetailsCard'
import { CanvasViewportControls } from './controls/CanvasViewportControls'
import { CanvasFolderNavigation } from './controls/CanvasFolderNavigation'
import { useCanvasUploadBridge } from './upload/useCanvasUploadBridge'

const EMPTY_SAVED_NODE_LAYOUTS: readonly CanvasNodeLayout[] = []
const CANVAS_FLOATING_PANEL_BOTTOM_OFFSET_PX = 56
/** Horizontal gap between a card and the new card "run again" or "generate video" places beside it. */
const REGENERATED_CARD_GAP_X = 48
/** Stagger applied when one placement request yields several Resources. */
const PLACEMENT_STAGGER_PX = 36
const WORKSPACE_REACT_FLOW_PRO_OPTIONS = { hideAttribution: true } as const

interface CurrentCanvasFolder {
  readonly folderKey: string
  readonly name: string
  readonly workspacePath: string
  readonly ancestors: readonly WorkspaceResourceAncestorView[]
}

interface ProjectWorkspaceCanvasContentProps {
  readonly selection: WorkspaceCanvasSelection | null
  readonly onSelectionChange: (selection: WorkspaceCanvasSelection | null) => void
  readonly onAssistantDraftRequest: (request: WorkspaceAssistantDraftRequest) => void
  readonly activeAssistantFocusRequest?: WorkspaceAssistantActiveFocusRequest | null
  readonly assistantTurnOutcomes?: readonly WorkspaceAssistantTurnOutcomeView[]
  readonly workspacePathFocusRequest?: WorkspaceCanvasPathFocusRequest | null
}

const EMPTY_TURN_OUTCOMES: readonly WorkspaceAssistantTurnOutcomeView[] = []

interface WorkspaceCanvasUserPosition {
  readonly x: number
  readonly y: number
}

function applyWorkspaceCanvasUserPositions(params: {
  readonly nodes: readonly WorkspaceCanvasFlowNode[]
  readonly positions: ReadonlyMap<string, WorkspaceCanvasUserPosition>
}): WorkspaceCanvasFlowNode[] {
  return params.nodes.map((node) => {
    const position = params.positions.get(node.id)
    if (!position) return node
    return {
      ...node,
      position,
      data: { ...node.data, layoutBasePosition: position },
    }
  })
}

function flattenResources(data: ReturnType<typeof useWorkspaceResources>['data']): WorkspaceResourceView[] {
  const byId = new Map<string, WorkspaceResourceView>()
  for (const page of data?.pages ?? []) {
    for (const resource of page.items) byId.set(resource.resourceId, resource)
  }
  return [...byId.values()]
}

function folderFromResource(resource: WorkspaceResourceView): CurrentCanvasFolder {
  if (resource.resourceKind !== 'folder') {
    throw new Error(`WORKSPACE_CANVAS_FOLDER_REQUIRED:${resource.resourceId}`)
  }
  return {
    folderKey: resource.resourceId,
    name: resource.name,
    workspacePath: resource.workspacePath,
    ancestors: resource.ancestors,
  }
}

function parentFolderFromResource(resource: WorkspaceResourceView, rootName: string): CurrentCanvasFolder {
  const parent = resource.ancestors.at(-1)
  if (!parent) {
    return {
      folderKey: WORKSPACE_RESOURCE_ROOT_FOLDER_KEY,
      name: rootName,
      workspacePath: '',
      ancestors: [],
    }
  }
  return {
    folderKey: parent.resourceId,
    name: parent.name,
    workspacePath: parent.workspacePath,
    ancestors: resource.ancestors.slice(0, -1),
  }
}

function isFolderNodeData(
  data: WorkspaceCanvasNodeRecord,
): data is WorkspaceCanvasFolderNodeData & Record<string, unknown> {
  return data.kind === 'folder'
}

function ProjectWorkspaceFolderCanvas({
  folder,
  rootName,
  pendingLocateResourceId,
  onNavigate,
  onLocateConsumed,
  selection,
  onSelectionChange,
  onAssistantDraftRequest,
  activeAssistantFocusRequest = null,
  assistantTurnOutcomes = EMPTY_TURN_OUTCOMES,
}: ProjectWorkspaceCanvasContentProps & {
  readonly folder: CurrentCanvasFolder
  readonly rootName: string
  readonly pendingLocateResourceId: string | null
  readonly onNavigate: (folder: CurrentCanvasFolder, locateResourceId?: string | null) => void
  readonly onLocateConsumed: () => void
}) {
  const t = useTranslations('projectWorkflow.canvas.workspace')
  const tCreate = useTranslations('projectWorkflow.canvas.workspace.create')
  const { projectId } = useWorkspaceProvider()
  const { data: projectData } = useProjectData(projectId)
  const projectAspectRatio = projectData?.videoRatio ?? null
  const currentFolderPath = folder.folderKey === WORKSPACE_RESOURCE_ROOT_FOLDER_KEY ? null : folder.workspacePath
  const generationCapabilitiesQuery = useCanvasGenerationCapabilities(projectId)
  const generationCapabilities = generationCapabilitiesQuery.isError || generationCapabilitiesQuery.isFetching ? null : generationCapabilitiesQuery.data ?? null
  const folderQuery = useWorkspaceResources({
    projectId,
    prefix: folder.workspacePath || null,
    search: null,
    scope: 'subtree',
  })
  const resources = useMemo(() => flattenResources(folderQuery.data), [folderQuery.data])
  const fetchNextFolderPage = folderQuery.fetchNextPage
  const folderHasNextPage = folderQuery.hasNextPage
  const folderFetchingNextPage = folderQuery.isFetchingNextPage
  useEffect(() => {
    if (!folderHasNextPage || folderFetchingNextPage) return
    void fetchNextFolderPage()
  }, [fetchNextFolderPage, folderFetchingNextPage, folderHasNextPage])

  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim()
  const searchQuery = useWorkspaceResources({
    projectId,
    prefix: null,
    search: normalizedSearch || null,
    enabled: Boolean(normalizedSearch),
  })
  const searchResults = useMemo(() => flattenResources(searchQuery.data), [searchQuery.data])
  const reactFlow = useReactFlow<WorkspaceCanvasFlowNode>()
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [userNodePositions, setUserNodePositions] = useState<ReadonlyMap<string, WorkspaceCanvasUserPosition>>(() => new Map())
  const [preview, setPreview] = useState<{
    readonly members: readonly WorkspaceResourceCardMemberView[]
    readonly initialResourceId: string
  } | null>(null)
  const [reactFlowReady, setReactFlowReady] = useState(false)
  const resolvedProjectedNodesRef = useRef<readonly WorkspaceCanvasFlowNode[]>([])
  const projectedFlowNodesRef = useRef<readonly WorkspaceCanvasFlowNode[]>([])
  const projectedFlowEdgesRef = useRef<readonly WorkspaceCanvasFlowEdge[]>([])
  const appliedProjectionSignatureRef = useRef<string | null>(null)
  const appliedInitialViewportRef = useRef(false)
  const projectionSignatureRef = useRef('')
  const reactFlowRef = useRef(reactFlow)
  useLayoutEffect(() => { reactFlowRef.current = reactFlow }, [reactFlow])
  const userNodePositionsRef = useRef<ReadonlyMap<string, WorkspaceCanvasUserPosition>>(new Map())
  const layoutWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  const pendingPlacementNodeIdsRef = useRef<Set<string>>(new Set())
  const operationAction = useCanvasOperationAction({ projectId })
  const history = useCanvasHistory()
  const restoreAction = useCanvasResourceRestoreAction({ projectId })
  const multiSelection = useCanvasMultiSelection({ reactFlow, containerRef: canvasRef })
  const deleteAction = useCanvasResourceDeleteAction({
    projectId,
    onDeleted: (deleted) => {
      if (deleted.some((input) => input.resourceId === selection?.targetId)) onSelectionChange(null)
      multiSelection.clear()
      history.push({
        kind: 'delete',
        resources: deleted.map((input) => {
          const node = projectedFlowNodesRef.current.find((candidate) => candidate.data.targetId === input.resourceId)
          return { resourceId: input.resourceId, workspacePath: input.workspacePath, name: node?.data.title ?? input.workspacePath }
        }),
      })
    },
  })
  // Pins Resources the Canvas itself asked for (uploads, "run again") at the
  // position of that request. Identity comes from the Operation's own
  // acknowledgement, never from query order; the projection still owns the
  // node, this only seeds its layout position.
  const pinResourcePositions = useCallback((
    resourceIds: readonly string[],
    origin: WorkspaceCanvasUserPosition,
  ) => {
    const uniqueIds = [...new Set(resourceIds)]
    if (uniqueIds.length === 0) return
    setUserNodePositions((current) => {
      const next = new Map(current)
      uniqueIds.forEach((resourceId, index) => {
        const nodeId = workspaceNodeId.resourceCard(resourceId)
        pendingPlacementNodeIdsRef.current.add(nodeId)
        next.set(nodeId, {
          x: origin.x + (index % 3) * PLACEMENT_STAGGER_PX,
          y: origin.y + Math.floor(index / 3) * PLACEMENT_STAGGER_PX,
        })
      })
      return next
    })
  }, [])
  const placeUploadedResource = useCallback((item: CanvasUploadQueueItem, resourceId: string, reused: boolean) => {
    if (reused) return
    pinResourcePositions([resourceId], item.position)
  }, [pinResourcePositions])
  const uploadQueue = useCanvasUploadQueue({
    projectId,
    folderPath: currentFolderPath,
    onMaterialized: placeUploadedResource,
  })
  const {
    layout,
    isLoading: layoutLoading,
    loadError: layoutLoadError,
    reloadLayout,
    saveLayout,
  } = useCanvasLayoutPersistence({ projectId, folderKey: folder.folderKey })
  const projectionComplete = !folderQuery.isLoading
    && !folderQuery.isError
    && !folderQuery.hasNextPage
    && !folderQuery.isFetchingNextPage
    && !layoutLoading
    && !layoutLoadError

  const savedNodeLayouts = layout?.nodeLayouts ?? EMPTY_SAVED_NODE_LAYOUTS
  // Session-monotonic collapse seed: folders folded during this canvas visit
  // never pop back open mid-session (the seed resets with the per-folder mount).
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set())
  const projection = useWorkspaceNodeCanvasProjection({
    projectId,
    projectAspectRatio,
    currentFolderPath: folder.workspacePath || null,
    collapsedSeed: collapsedFolders,
    workspaceResources: resources,
    savedLayouts: savedNodeLayouts,
    translate: t,
  })
  const projectedNodes = projection.nodes
  const projectionEdges = projection.edges
  const nextCollapsedFolders = new Set<string>()
  for (const node of projectedNodes) {
    if (node.data.kind === 'folder' && node.data.folder.display === 'card') {
      nextCollapsedFolders.add(node.data.folder.resourceId)
    }
  }
  if (nextCollapsedFolders.size !== collapsedFolders.size
    || [...nextCollapsedFolders].some((id) => !collapsedFolders.has(id))) {
    setCollapsedFolders(nextCollapsedFolders)
  }
  const projectedResourceIds = useMemo(() => new Set(
    projectedNodes.flatMap((node) => (node.data.kind === 'resourceCard' ? [node.data.targetId] : [])),
  ), [projectedNodes])
  const buildDraftMessage = useCallback((composition: CanvasDraftComposition) => buildCanvasDraftMessage({
    composition,
    folderPath: currentFolderPath,
    t: (key, values) => tCreate(key, values),
  }), [currentFolderPath, tCreate])
  const createDraft = useCanvasCreateDraft({
    projectId,
    folderPath: currentFolderPath,
    projectAspectRatio,
    capabilities: generationCapabilities,
    turnOutcomes: assistantTurnOutcomes,
    projectedResourceIds,
    buildMessage: buildDraftMessage,
    submitToAssistant: onAssistantDraftRequest,
    pinResources: pinResourcePositions,
  })
  const draftCardRef = useRef<HTMLDivElement | null>(null)
  const workspaceRuntimeTargets = useMemo(
    () => collectWorkspaceNodeRuntimeTargets(projectedNodes),
    [projectedNodes],
  )
  const workspaceTaskStateMap = useTaskTargetStateMap(projectId, workspaceRuntimeTargets, {
    enabled: Boolean(projectId && workspaceRuntimeTargets.length > 0),
    staleTime: 1000,
  })
  const attachNodeUiState = useCallback((inputNodes: readonly WorkspaceCanvasFlowNode[]) => (
    inputNodes.map((node) => {
      const resolvedData = resolveWorkspaceCanvasNodeData({
        node,
        statesByQueryKey: workspaceTaskStateMap.byQueryKey,
      })
      const isSelected = node.id === selection?.nodeId
      return {
        ...node,
        zIndex: isSelected ? 30 : undefined,
        data: {
          ...resolvedData,
          uiSelected: isSelected,
          uiMultiSelected: !isSelected && multiSelection.selectedNodeIds.has(node.id),
        },
      }
    })
  ), [multiSelection.selectedNodeIds, selection?.nodeId, workspaceTaskStateMap.byQueryKey])
  const resolvedProjectedNodes = useMemo(
    () => attachNodeUiState(projectedNodes),
    [attachNodeUiState, projectedNodes],
  )
  const flowNodes = useMemo(() => applyWorkspaceCanvasUserPositions({
    nodes: resolvedProjectedNodes,
    positions: userNodePositions,
  }), [resolvedProjectedNodes, userNodePositions])
  const selectedNode = useMemo(
    () => flowNodes.find((node) => node.id === selection?.nodeId && node.data.kind === 'resourceCard') ?? null,
    [flowNodes, selection?.nodeId],
  )
  const [detailsReferenceDrop, setDetailsReferenceDrop] = useState<WorkspaceNodeReferenceDropRequest | null>(null)
  const referenceDrop = useCanvasReferenceDrop({
    draftTargetRef: draftCardRef,
    detailsTargetSelector: selectedNode ? `[data-node-details-for="${CSS.escape(selectedNode.id)}"]` : null,
  })
  const flowNodeSignature = useMemo(() => buildWorkspaceCanvasNodeSignature(flowNodes), [flowNodes])
  const [initialReactFlowNodes] = useState(() => [...flowNodes])
  const projectionNodeSignature = useMemo(
    () => buildWorkspaceCanvasNodeSignature(resolvedProjectedNodes),
    [resolvedProjectedNodes],
  )
  const visibleNodeIds = useMemo(() => new Set(flowNodes.map((node) => node.id)), [flowNodes])
  const visibleProjectionEdges = useMemo(
    () => projectionEdges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    [projectionEdges, visibleNodeIds],
  )
  const projectionEdgeSignature = useMemo(
    () => buildWorkspaceCanvasEdgeSignature(visibleProjectionEdges),
    [visibleProjectionEdges],
  )
  const [initialReactFlowEdges] = useState(() => [...visibleProjectionEdges])
  // Imperative React Flow callbacks must only observe the committed projection.
  useLayoutEffect(() => {
    resolvedProjectedNodesRef.current = resolvedProjectedNodes
    userNodePositionsRef.current = userNodePositions
    projectedFlowNodesRef.current = flowNodes
    projectedFlowEdgesRef.current = visibleProjectionEdges
    projectionSignatureRef.current = `${flowNodeSignature}\n--edges--\n${projectionEdgeSignature}`
  }, [flowNodeSignature, flowNodes, projectionEdgeSignature, resolvedProjectedNodes, userNodePositions, visibleProjectionEdges])
  const syncProjectionToReactFlow = useCallback((flow = reactFlowRef.current) => {
    const signature = projectionSignatureRef.current
    if (appliedProjectionSignatureRef.current === signature) return
    appliedProjectionSignatureRef.current = signature
    flow.setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node] as const))
      return projectedFlowNodesRef.current.map((node) => {
        const current = currentById.get(node.id)
        return current?.measured ? { ...node, measured: current.measured } : node
      })
    })
    flow.setEdges([...projectedFlowEdgesRef.current])
  }, [])
  const handleReactFlowInit = useCallback((flow: typeof reactFlow) => {
    reactFlowRef.current = flow
    setReactFlowReady(true)
  }, [])
  useEffect(() => {
    if (!reactFlowReady) return
    syncProjectionToReactFlow()
  }, [flowNodeSignature, projectionEdgeSignature, reactFlowReady, syncProjectionToReactFlow])
  useEffect(() => {
    if (!reactFlowReady || layoutLoading || appliedInitialViewportRef.current) return
    appliedInitialViewportRef.current = true
    void reactFlow.setViewport(layout?.viewport ?? DEFAULT_WORKSPACE_CANVAS_VIEWPORT, { duration: 0 })
  }, [layout?.viewport, layoutLoading, reactFlow, reactFlowReady])
  const focusNodeIds = useMemo(() => resolveWorkspaceCanvasFocusNodeIds(
    flowNodes,
    activeAssistantFocusRequest?.taskTargets ?? [],
  ), [activeAssistantFocusRequest?.taskTargets, flowNodes])
  const { notifyUserInteraction: notifyCanvasUserInteraction } = useCanvasFocusFollow({
    reactFlow,
    containerRef: canvasRef,
    enabled: true,
    focusNodeIds,
    focusRequestKey: activeAssistantFocusRequest?.requestKey ?? null,
  })
  const {
    accept: uploadAccept,
    uploadInputRef,
    openPicker: openUploadPicker,
    handleInputChange: handleUploadInputChange,
    handleDrop: handleCanvasDrop,
    handlePaste: handleCanvasPaste,
    handleDragOver: handleCanvasDragOver,
  } = useCanvasUploadBridge({
    canvasRef,
    screenToFlowPosition: reactFlow.screenToFlowPosition,
    addFiles: uploadQueue.addFiles,
    onUserInteraction: notifyCanvasUserInteraction,
  })

  useEffect(() => {
    const projectedNodeIds = new Set(projectedNodes.map((node) => node.id))
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reconcile the local drag cache with the received resource projection.
    setUserNodePositions((current) => {
      let changed = false
      const next = new Map<string, WorkspaceCanvasUserPosition>()
      current.forEach((position, nodeId) => {
        if (projectedNodeIds.has(nodeId)) next.set(nodeId, position)
        else changed = true
      })
      return changed ? next : current
    })
  }, [projectedNodes, projectionNodeSignature])

  const persistCurrentLayout = useCallback(async (nextNodes: readonly WorkspaceCanvasFlowNode[]) => {
    if (!projectionComplete) return
    const foldersByPath = new Map(resources.filter((resource) => resource.resourceKind === 'folder')
      .map((resource) => [resource.workspacePath, workspaceNodeId.folder(resource.resourceId)]))
    const parentNodeKeys = new Map(resources.flatMap((resource) => {
      const path = workspaceResourceParentPath(resource.workspacePath)
      const parent = path === null ? undefined : foldersByPath.get(path)
      const key = resource.resourceKind === 'folder' ? workspaceNodeId.folder(resource.resourceId) : workspaceNodeId.resourceCard(resource.resourceId)
      return parent ? [[key, parent] as const] : []
    }))
    const input = buildWorkspaceCanvasLayoutInput({
      folderKey: folder.folderKey,
      viewport: reactFlowRef.current.getViewport(),
      nodes: nextNodes,
      retainedLayouts: layout?.nodeLayouts,
      parentNodeKeys,
      existingNodeKeys: new Set(resources.map((resource) => resource.resourceKind === 'folder'
        ? workspaceNodeId.folder(resource.resourceId) : workspaceNodeId.resourceCard(resource.resourceId))),
    })
    const write = layoutWriteChainRef.current
      .catch(() => undefined)
      .then(async () => { await saveLayout(input) })
    layoutWriteChainRef.current = write.catch(() => undefined)
    await write
  }, [folder.folderKey, layout?.nodeLayouts, projectionComplete, resources, saveLayout])

  useEffect(() => {
    if (pendingPlacementNodeIdsRef.current.size === 0) return
    const projectedNodeIds = new Set(resolvedProjectedNodes.map((node) => node.id))
    const matched = [...pendingPlacementNodeIdsRef.current].filter((nodeId) => projectedNodeIds.has(nodeId))
    if (matched.length === 0) return
    const positions = new Map(userNodePositionsRef.current)
    const occupied = resolvedProjectedNodes.filter((node) => !node.parentId && !matched.includes(node.id)).map((node) => ({
      ...(positions.get(node.id) ?? node.position), width: node.data.width, height: node.data.height,
    }))
    for (const nodeId of matched) {
      const node = resolvedProjectedNodes.find((item) => item.id === nodeId)
      if (!node) continue
      if (node.parentId) {
        const parent = resolvedProjectedNodes.find((item) => item.id === node.parentId)
        if (!parent) throw new Error('CANVAS_LAYOUT_PARENT_MISSING')
        const parentPosition = positions.get(parent.id) ?? parent.position
        const origin = positions.get(nodeId)
        if (origin) positions.set(nodeId, { x: origin.x - parentPosition.x, y: origin.y - parentPosition.y })
        continue
      }
      const position = vacantCanvasPosition({ ...(positions.get(nodeId) ?? node.position), width: node.data.width, height: node.data.height }, occupied)
      positions.set(nodeId, position)
      occupied.push({ ...position, width: node.data.width, height: node.data.height })
    }
    matched.forEach((nodeId) => pendingPlacementNodeIdsRef.current.delete(nodeId))
    setUserNodePositions(positions)
    void persistCurrentLayout(applyWorkspaceCanvasUserPositions({ nodes: resolvedProjectedNodes, positions })).catch((error: unknown) => {
      _ulogWarn('[ProjectWorkspaceCanvas] generated Resource placement save failed', error)
    })
  }, [persistCurrentLayout, resolvedProjectedNodes, userNodePositions])

  const persistCurrentLayoutSafely = useCallback((nextNodes: readonly WorkspaceCanvasFlowNode[]) => {
    void persistCurrentLayout(nextNodes).catch((error: unknown) => {
      _ulogWarn('[ProjectWorkspaceCanvas] canvas layout save failed', error)
    })
  }, [persistCurrentLayout])
  const dragStartPositionsRef = useRef<Map<string, WorkspaceCanvasUserPosition>>(new Map())
  const handleNodeDragStart = useCallback<OnNodeDrag<WorkspaceCanvasFlowNode>>((_event, node, draggedNodes) => {
    notifyCanvasUserInteraction()
    const dragged = [node, ...draggedNodes]
    dragStartPositionsRef.current = new Map(dragged.map((item) => [item.id, { x: item.position.x, y: item.position.y }]))
    referenceDrop.onDragStart(dragged)
  }, [notifyCanvasUserInteraction, referenceDrop])
  const applyUserNodePositions = useCallback((nodes: readonly WorkspaceCanvasFlowNode[]) => {
    setUserNodePositions((current) => {
      const next = new Map(current)
      nodes.forEach((node) => next.set(node.id, { x: node.position.x, y: node.position.y }))
      return next
    })
  }, [])
  const handleNodeDrag = useCallback<OnNodeDrag<WorkspaceCanvasFlowNode>>((_event, node, draggedNodes) => {
    applyUserNodePositions([node, ...draggedNodes])
    referenceDrop.onDrag(node, _event)
  }, [applyUserNodePositions, referenceDrop])
  const handleNodeDragStop = useCallback<OnNodeDrag<WorkspaceCanvasFlowNode>>((_event, node, draggedNodes) => {
    notifyCanvasUserInteraction()
    const movedNodes = [node, ...draggedNodes]
    const drop = referenceDrop.onDragStop(node, _event)
    if (drop) {
      // A reference drop is not a move: every dragged node springs back and
      // nothing is persisted; the dropped card only hands over its facts.
      setUserNodePositions((current) => {
        const next = new Map(current)
        movedNodes.forEach((movedNode) => {
          const start = drop.startPositions.get(movedNode.id)
          if (start) next.set(movedNode.id, start)
        })
        return next
      })
      const candidate = node.data.kind === 'resourceCard'
        ? canvasDraftReferenceCandidate(node.data.resourceDetails)
        : null
      if (!candidate) return
      if (drop.target === 'draft') createDraft.addReference(candidate)
      else setDetailsReferenceDrop({ requestId: crypto.randomUUID(), candidate })
      return
    }
    const nextPositions = new Map(userNodePositionsRef.current)
    movedNodes.forEach((movedNode) => nextPositions.set(movedNode.id, movedNode.position))
    const changes = movedNodes.flatMap((movedNode) => {
      const from = dragStartPositionsRef.current.get(movedNode.id)
      if (!from || (from.x === movedNode.position.x && from.y === movedNode.position.y)) return []
      return [{ nodeId: movedNode.id, from, to: { x: movedNode.position.x, y: movedNode.position.y } }]
    })
    if (changes.length > 0) history.push({ kind: 'move', changes })
    applyUserNodePositions(movedNodes)
    persistCurrentLayoutSafely(applyWorkspaceCanvasUserPositions({
      nodes: resolvedProjectedNodesRef.current,
      positions: nextPositions,
    }))
  }, [applyUserNodePositions, createDraft, history, notifyCanvasUserInteraction, persistCurrentLayoutSafely, referenceDrop])
  const applyHistoryMove = useCallback((changes: readonly { readonly nodeId: string; readonly from: WorkspaceCanvasUserPosition; readonly to: WorkspaceCanvasUserPosition }[], direction: 'undo' | 'redo') => {
    const nextPositions = new Map(userNodePositionsRef.current)
    changes.forEach((change) => nextPositions.set(change.nodeId, direction === 'undo' ? change.from : change.to))
    setUserNodePositions(nextPositions)
    persistCurrentLayoutSafely(applyWorkspaceCanvasUserPositions({
      nodes: resolvedProjectedNodesRef.current,
      positions: nextPositions,
    }))
  }, [persistCurrentLayoutSafely])
  const undoLastAction = useCallback(() => {
    const entry = history.undo()
    if (!entry) return
    if (entry.kind === 'move') applyHistoryMove(entry.changes, 'undo')
    else void restoreAction.restore(entry.resources)
  }, [applyHistoryMove, history, restoreAction])
  const redoLastAction = useCallback(() => {
    const entry = history.redo()
    if (entry) applyHistoryMove(entry.changes, 'redo')
  }, [applyHistoryMove, history])

  const selectionForNode = useCallback((node: WorkspaceCanvasFlowNode): WorkspaceCanvasSelection | null => {
    if (node.data.kind !== 'resourceCard') return null
    const summary = node.data.resourceDetails.presentation.summary
    return {
      nodeId: node.id,
      targetType: 'workspaceResource',
      targetId: node.data.targetId,
      selectedScopeRef: `workspaceResource:${node.data.targetId}`,
      selectedAssetId: null,
      name: node.data.title,
      mediaType: node.data.resourceDetails.resource.mediaType,
      previewUrl: summary.kind === 'media' ? summary.url : null,
    }
  }, [])
  const locateProjectedResource = useCallback((resourceId: string): boolean => {
    if (!reactFlowReady) return false
    const node = flowNodes.find((candidate) => (
      candidate.data.kind === 'resourceCard' && candidate.data.targetId === resourceId
    ))
    if (!node) return false
    canvasRef.current?.focus()
    const nextSelection = selectionForNode(node)
    if (nextSelection) onSelectionChange(nextSelection)
    notifyCanvasUserInteraction()
    void reactFlow.fitView({ nodes: [node], padding: 0.35, maxZoom: 1, duration: 180 })
    return true
  }, [flowNodes, notifyCanvasUserInteraction, onSelectionChange, reactFlow, reactFlowReady, selectionForNode])
  const openProjectedFolder = useCallback((target: WorkspaceCanvasFolderOpenTarget) => {
    const parent: WorkspaceResourceAncestorView[] = folder.folderKey === WORKSPACE_RESOURCE_ROOT_FOLDER_KEY
      ? []
      : [...folder.ancestors, {
          resourceId: folder.folderKey,
          name: folder.name,
          workspacePath: folder.workspacePath,
        }]
    onNavigate({
      folderKey: target.resourceId,
      name: target.name,
      workspacePath: target.workspacePath,
      ancestors: parent,
    })
  }, [folder, onNavigate])
  const selectResourceNode = useCallback((nodeId: string, request: { readonly additive: boolean }) => {
    canvasRef.current?.focus()
    const node = flowNodes.find((candidate) => candidate.id === nodeId)
    if (!node) return
    if (request.additive) {
      multiSelection.toggle(nodeId)
      return
    }
    multiSelection.clear()
    const nextSelection = selectionForNode(node)
    if (nextSelection) onSelectionChange(nextSelection)
  }, [flowNodes, multiSelection, onSelectionChange, selectionForNode])
  const handleNodeClick = useCallback<NodeMouseHandler<WorkspaceCanvasFlowNode>>((_event, node) => {
    canvasRef.current?.focus()
    if (!isFolderNodeData(node.data)) return
    // Expanded section frames behave like canvas background on single click;
    // only the collapsed folder card keeps click-to-enter (CN-02C).
    if (node.data.folder.display === 'section') {
      onSelectionChange(null)
      return
    }
    openProjectedFolder({
      resourceId: node.data.folder.resourceId,
      name: node.data.title,
      workspacePath: node.data.folder.workspacePath,
    })
  }, [onSelectionChange, openProjectedFolder])
  const handleNodeDoubleClick = useCallback<NodeMouseHandler<WorkspaceCanvasFlowNode>>((_event, node) => {
    if (!isFolderNodeData(node.data)) return
    openProjectedFolder({
      resourceId: node.data.folder.resourceId,
      name: node.data.title,
      workspacePath: node.data.folder.workspacePath,
    })
  }, [openProjectedFolder])
  const handlePaneClick = useCallback((event: ReactMouseEvent<Element, globalThis.MouseEvent>) => {
    canvasRef.current?.focus()
    // The click that ends a marquee must not discard the selection it drew.
    if (multiSelection.consumePaneClickSuppression()) return
    onSelectionChange(null)
    multiSelection.clear()
    if (event.detail !== 2) return
    notifyCanvasUserInteraction()
    const flow = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    createDraft.openMenu(flow)
  }, [createDraft, multiSelection, notifyCanvasUserInteraction, onSelectionChange, reactFlow])
  const handleMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) notifyCanvasUserInteraction()
  }, [notifyCanvasUserInteraction])
  const handleMoveEnd = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) notifyCanvasUserInteraction()
  }, [notifyCanvasUserInteraction])
  const applyWheelZoom = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (isWorkspaceCanvasWheelLockedTarget(event.target)) return
    // React routes synthetic events along the component tree, so a wheel inside
    // an overlay portaled out of the canvas subtree (reference picker modal,
    // image preview) still reaches this capture handler; only wheels over the
    // canvas' own DOM surface may zoom it.
    const surface = canvasRef.current
    if (!surface || !(event.target instanceof Node) || !surface.contains(event.target)) return
    const bounds = surface.getBoundingClientRect()
    event.preventDefault()
    const viewport = reactFlow.getViewport()
    const nextZoom = getNextWorkspaceCanvasWheelZoom(viewport.zoom, event.deltaY)
    if (nextZoom === viewport.zoom) return
    notifyCanvasUserInteraction()
    const pointerX = event.clientX - bounds.left
    const pointerY = event.clientY - bounds.top
    const zoomRatio = nextZoom / viewport.zoom
    const nextViewport: Viewport = {
      x: pointerX - (pointerX - viewport.x) * zoomRatio,
      y: pointerY - (pointerY - viewport.y) * zoomRatio,
      zoom: nextZoom,
    }
    void reactFlow.setViewport(nextViewport)
  }, [notifyCanvasUserInteraction, reactFlow])
  const fitView = useCallback(() => {
    notifyCanvasUserInteraction()
    void reactFlow.fitView({ padding: 0.14, duration: 180 })
  }, [notifyCanvasUserInteraction, reactFlow])
  const [arranging, setArranging] = useState(false)
  const [arrangeFailed, setArrangeFailed] = useState(false)
  const arrangeLayout = useCallback(async () => {
    if (!projectionComplete || arranging) return
    notifyCanvasUserInteraction()
    setArranging(true)
    setArrangeFailed(false)
    const arranged = buildWorkspaceNodeCanvasProjection({
      projectId, projectAspectRatio, currentFolderPath, collapsedSeed: collapsedFolders,
      workspaceResources: resources, savedLayouts: [], translate: t,
    }).nodes
    const positions = new Map(arranged.map((node) => [node.id, node.position]))
    const changes = resolvedProjectedNodesRef.current.filter((node) => positions.has(node.id)).map((node) => ({
      nodeId: node.id, from: userNodePositionsRef.current.get(node.id) ?? node.position, to: positions.get(node.id)!,
    }))
    try {
      await persistCurrentLayout(arranged)
      setUserNodePositions(positions)
      if (changes.length) history.push({ kind: 'move', changes })
    } catch {
      setArrangeFailed(true)
    } finally {
      setArranging(false)
    }
  }, [arranging, collapsedFolders, currentFolderPath, history, notifyCanvasUserInteraction, persistCurrentLayout, projectAspectRatio, projectId, projectionComplete, resources, t])
  const zoomIn = useCallback(() => {
    notifyCanvasUserInteraction()
    void reactFlow.zoomIn({ duration: 160 })
  }, [notifyCanvasUserInteraction, reactFlow])
  const zoomOut = useCallback(() => {
    notifyCanvasUserInteraction()
    void reactFlow.zoomOut({ duration: 160 })
  }, [notifyCanvasUserInteraction, reactFlow])
  useEffect(() => {
    if (!selection || folderQuery.isLoading || selectedNode) return
    onSelectionChange(null)
  }, [folderQuery.isLoading, onSelectionChange, selectedNode, selection])
  useEffect(() => {
    if (!pendingLocateResourceId || !locateProjectedResource(pendingLocateResourceId)) return
    onLocateConsumed()
  }, [locateProjectedResource, onLocateConsumed, pendingLocateResourceId])

  const requestAssistantDraft = useCallback((text: string | null) => {
    onAssistantDraftRequest({ kind: 'prefill', requestId: crypto.randomUUID(), text, focus: true })
  }, [onAssistantDraftRequest])
  const deleteTargetsForNodes = useCallback((nodes: readonly WorkspaceCanvasFlowNode[]): CanvasResourceDeleteTarget[] => (
    nodes.flatMap((node) => {
      if (node.data.kind !== 'resourceCard') return []
      const operation = node.data.resourceDetails.canvasOperations.find(
        (candidate): candidate is Extract<WorkspaceCanvasResourceOperationView, { kind: 'delete' }> => candidate.kind === 'delete',
      )
      return operation ? [{ operation, label: node.data.title }] : []
    })
  ), [])
  const beginResourceOperation = useCallback((operation: WorkspaceCanvasResourceOperationView) => {
    if (operation.confirmation === 'destructive') {
      if (!selectedNode || selectedNode.data.kind !== 'resourceCard') return
      deleteAction.begin([{ operation, label: selectedNode.data.title }])
      return
    }
    void operationAction.begin({
      operationId: operation.operationId,
      input: operation.input,
      confirmation: operation.confirmation,
    })
  }, [deleteAction, operationAction, selectedNode])
  const beginResourceRegeneration = useCallback((
    operation: WorkspaceCanvasBillableOperationView,
    input: WorkspaceResourceJsonObject,
  ) => {
    if (!selectedNode || selectedNode.data.kind !== 'resourceCard') return
    // Section members are packed by their folder frame; only free top-level
    // cards get the new card pinned beside them.
    const origin = selectedNode.parentId
      ? null
      : { x: selectedNode.position.x + selectedNode.data.width + REGENERATED_CARD_GAP_X, y: selectedNode.position.y }
    void operationAction.begin({
      operationId: operation.operationId,
      input,
      confirmation: operation.confirmation,
      onAccepted: ({ output }) => {
        if (!origin) return
        pinResourcePositions(
          readWorkspaceResourceOperationOutputResources(output).map((resource) => resource.resourceId),
          origin,
        )
      },
    })
  }, [operationAction, pinResourcePositions, selectedNode])
  const selectedCandidate = selectedNode?.data.kind === 'resourceCard'
    ? canvasDraftReferenceCandidate(selectedNode.data.resourceDetails)
    : null
  const beginAnimate = useMemo(() => {
    if (!selectedNode || !selectedCandidate || selectedCandidate.mediaType !== 'image') return null
    const capability = canvasGenerationCapabilityFor(generationCapabilities, 'video')
    if (!canvasDraftReferenceRoles('video', 'image', capability).includes('first_frame')) return null
    return () => {
      const anchor = reactFlow.getInternalNode(selectedNode.id)?.internals.positionAbsolute ?? selectedNode.position
      createDraft.startCompose({
        position: { x: anchor.x + selectedNode.data.width + REGENERATED_CARD_GAP_X, y: anchor.y },
        mediaType: 'video',
        references: [{ ...selectedCandidate, role: 'first_frame' }],
      })
    }
  }, [createDraft, generationCapabilities, reactFlow, selectedCandidate, selectedNode])
  const useSelectedAsReference = useMemo(() => {
    const draft = createDraft.draft
    if (draft?.phase !== 'compose' || !selectedCandidate) return null
    const capability = canvasGenerationCapabilityFor(generationCapabilities, draft.composition.mediaType)
    if (canvasDraftReferenceRoles(draft.composition.mediaType, selectedCandidate.mediaType, capability, draft.composition.references.map(canvasReferenceRole)).length === 0) return null
    if (draft.composition.references.some((reference) => reference.resourceId === selectedCandidate.resourceId)) return null
    return () => { createDraft.addReference(selectedCandidate) }
  }, [createDraft, generationCapabilities, selectedCandidate])
  const consumeDetailsReferenceDrop = useCallback((requestId: string) => {
    setDetailsReferenceDrop((current) => (current?.requestId === requestId ? null : current))
  }, [])
  const selectionForCard = useCallback((card: WorkspaceResourceCardMemberView): WorkspaceCanvasSelection | null => {
    const node = flowNodes.find((candidate) => candidate.data.targetId === card.resource.resourceId)
    return node ? selectionForNode(node) : null
  }, [flowNodes, selectionForNode])
  // 目录面板消费:当前画布上有节点的文件夹(展开分组或收起卡)及其形态。
  const folderDisplays = useMemo(() => {
    const map = new Map<string, 'card' | 'section'>()
    for (const node of projectedNodes) {
      if (node.data.kind === 'folder') map.set(node.data.folder.resourceId, node.data.folder.display)
    }
    return map
  }, [projectedNodes])
  // 顶层节点的 Catalog 路径:目录跳转按"目标文件夹子树 ∩ 画布顶层节点"求并集范围,
  // 因此没有直接文件的中间目录也能跳到其后代分组所在的区域。
  const canvasTopLevelEntries = useMemo(() => projectedNodes.flatMap((node) => {
    if (node.parentId) return []
    const workspacePath = node.data.kind === 'folder'
      ? node.data.folder.workspacePath
      : node.data.resourceDetails.resource.workspacePath
    return [{ nodeId: node.id, workspacePath, width: node.data.width, height: node.data.height }]
  }), [projectedNodes])
  const canvasSubtreePaths = useMemo(
    () => canvasTopLevelEntries.map((entry) => entry.workspacePath),
    [canvasTopLevelEntries],
  )
  const jumpToFolder = useCallback((target: WorkspaceResourceView): boolean => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const entry of canvasTopLevelEntries) {
      if (!isWorkspaceResourceSubtreePath(entry.workspacePath, target.workspacePath)) continue
      const internalNode = reactFlow.getInternalNode(entry.nodeId)
      if (!internalNode) continue
      const { x, y } = internalNode.internals.positionAbsolute
      const width = internalNode.measured.width ?? entry.width
      const height = internalNode.measured.height ?? entry.height
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + width)
      maxY = Math.max(maxY, y + height)
    }
    if (!Number.isFinite(minX)) return false
    notifyCanvasUserInteraction()
    void reactFlow.fitBounds(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      { duration: 380, padding: 0.15 },
    )
    return true
  }, [canvasTopLevelEntries, notifyCanvasUserInteraction, reactFlow])
  const handleGoBack = useCallback(() => {
    if (folder.folderKey === WORKSPACE_RESOURCE_ROOT_FOLDER_KEY) return
    const parent = folder.ancestors.at(-1)
    onNavigate(parent ? {
      folderKey: parent.resourceId,
      name: parent.name,
      workspacePath: parent.workspacePath,
      ancestors: folder.ancestors.slice(0, -1),
    } : {
      folderKey: WORKSPACE_RESOURCE_ROOT_FOLDER_KEY,
      name: rootName,
      workspacePath: '',
      ancestors: [],
    })
  }, [folder.ancestors, folder.folderKey, onNavigate, rootName])
  const handleSearchResult = useCallback((resource: WorkspaceResourceView) => {
    setSearch('')
    if (resource.resourceKind === 'folder') {
      onNavigate(folderFromResource(resource))
      return
    }
    if (locateProjectedResource(resource.resourceId)) return
    onNavigate(parentFolderFromResource(resource, rootName), resource.resourceId)
  }, [locateProjectedResource, onNavigate, rootName])

  const handleCanvasKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isWorkspaceCanvasEditableTarget(event.target)) return
    const modifier = event.metaKey || event.ctrlKey
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redoLastAction()
      else undoLastAction()
      return
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redoLastAction()
      return
    }
    if (event.key === 'Escape') {
      multiSelection.clear()
      return
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    if (deleteAction.busy || operationAction.busy) return
    const bulkNodes = flowNodes.filter((node) => multiSelection.selectedNodeIds.has(node.id))
    const targets = deleteTargetsForNodes(bulkNodes.length > 0 ? bulkNodes : selectedNode ? [selectedNode] : [])
    if (targets.length === 0) return
    event.preventDefault()
    deleteAction.begin(targets)
  }, [deleteAction, deleteTargetsForNodes, flowNodes, multiSelection, operationAction.busy, redoLastAction, selectedNode, undoLastAction])

  const loading = folderQuery.isLoading || layoutLoading
  const failed = folderQuery.isError || Boolean(layoutLoadError)
  const folderActions = useMemo(() => ({
    busy: deleteAction.busy || operationAction.busy,
    open: openProjectedFolder,
    remove: (target: WorkspaceCanvasFolderOpenTarget & {
      readonly operation: WorkspaceCanvasFolderNodeData['folder']['deleteOperation']
    }) => deleteAction.begin([{ operation: target.operation, label: target.name }]),
  }), [deleteAction, openProjectedFolder, operationAction.busy])
  return (
    <WorkspaceCanvasFolderActionsContext.Provider value={folderActions}>
      <WorkspaceCanvasResourceSelectionContext.Provider value={selectResourceNode}>
      <div
      className="workspace-canvas-layout-animated relative h-full min-h-0 w-full overflow-hidden bg-[var(--glass-bg-canvas)]"
      onDragOver={handleCanvasDragOver}
      onDrop={handleCanvasDrop}
      onPaste={handleCanvasPaste}
    >
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        accept={uploadAccept}
        className="hidden"
        onChange={handleUploadInputChange}
      />
      <div
        ref={canvasRef}
        className="relative h-full outline-none"
        tabIndex={0}
        onWheelCapture={applyWheelZoom}
        onKeyDown={handleCanvasKeyDown}
        onPointerDownCapture={multiSelection.marqueeHandlers.onPointerDownCapture}
        onMouseDownCapture={multiSelection.marqueeHandlers.onMouseDownCapture}
      >
        <ReactFlow
          defaultNodes={initialReactFlowNodes}
          defaultEdges={initialReactFlowEdges}
          nodeTypes={workspaceNodeTypes}
          onInit={handleReactFlowInit}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onPaneClick={handlePaneClick}
          onNodeDragStart={handleNodeDragStart}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onMoveStart={handleMoveStart}
          onMoveEnd={handleMoveEnd}
          nodesDraggable={!arranging}
          nodesConnectable={false}
          elementsSelectable={false}
          onlyRenderVisibleElements
          minZoom={WORKSPACE_CANVAS_MIN_ZOOM}
          maxZoom={WORKSPACE_CANVAS_MAX_ZOOM}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          defaultViewport={layout?.viewport ?? DEFAULT_WORKSPACE_CANVAS_VIEWPORT}
          proOptions={WORKSPACE_REACT_FLOW_PRO_OPTIONS}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <Panel position="top-left" className="!z-[80] !m-0" style={{ left: 16, top: 72 }}>
            <CanvasFolderNavigation
              canGoBack={folder.folderKey !== WORKSPACE_RESOURCE_ROOT_FOLDER_KEY}
              onBack={handleGoBack}
              folderDisplays={folderDisplays}
              canvasSubtreePaths={canvasSubtreePaths}
              onJumpToFolder={jumpToFolder}
              search={search}
              backLabel={t('folderNavigation.back')}
              searchPlaceholder={t('folderNavigation.searchPlaceholder')}
              searchResultsLabel={t('folderNavigation.searchResults')}
              noResultsLabel={t('folderNavigation.noResults')}
              loadingLabel={t('folderNavigation.loading')}
              loadFailedLabel={t('folderNavigation.loadFailed')}
              retryLabel={t('folderNavigation.retry')}
              loadMoreLabel={t('folderNavigation.loadMore')}
              searchResults={searchResults}
              searchLoading={searchQuery.isLoading || searchQuery.isFetching}
              searchFailed={searchQuery.isError}
              searchHasMore={Boolean(searchQuery.hasNextPage)}
              onSearchChange={setSearch}
              onSearchResult={handleSearchResult}
              onRetrySearch={() => { void searchQuery.refetch() }}
              onLoadMoreSearch={() => { void searchQuery.fetchNextPage() }}
            />
          </Panel>
          {folderQuery.isFetchingNextPage ? (
            <Panel position="top-right" className="!m-0" style={{ right: 16, top: 16 }}>
              <span className="rounded-full bg-white/90 px-3 py-1.5 text-xs text-[var(--glass-text-secondary)] shadow-sm">
                {t('folderNavigation.loading')}
              </span>
            </Panel>
          ) : null}
          {createDraft.draft?.phase === 'menu' ? (
            <ViewportPortal key={createDraft.draft.id}>
              <WorkspaceCanvasCreateMenu
                position={createDraft.draft.position}
                onCreate={(mediaType) => createDraft.startCompose({ position: createDraft.draft!.position, mediaType })}
                onUpload={() => {
                  openUploadPicker(createDraft.draft!.position)
                  createDraft.close()
                }}
                onClose={() => createDraft.close()}
              />
            </ViewportPortal>
          ) : createDraft.draft ? (
            <ViewportPortal key={createDraft.draft.id}>
              <WorkspaceCanvasDraftCard
                projectId={projectId}
                folderPath={currentFolderPath}
                onAddReference={createDraft.addReference}
                onUploadedReference={(resourceId, reused) => {
                  if (!reused && createDraft.draft) pinResourcePositions([resourceId], createDraft.draft.position)
                }}
                draft={createDraft.draft}
                projectAspectRatio={projectAspectRatio}
                capability={canvasGenerationCapabilityFor(
                  generationCapabilities,
                  createDraft.draft.phase === 'compose' ? createDraft.draft.composition.mediaType : createDraft.draft.mediaType,
                )}
                capabilitiesLoading={generationCapabilitiesQuery.isFetching}
                capabilitiesFailed={generationCapabilitiesQuery.isError}
                dropTargetRef={draftCardRef}
                dropHighlighted={referenceDrop.activeTarget === 'draft'}
                onChangeText={(text) => createDraft.updateComposition({ text })}
                onChangeAspectRatio={(aspectRatio) => createDraft.updateComposition({ aspectRatio })}
                onChangeParameter={createDraft.setParameter}
                onChangeDuration={(durationSeconds) => createDraft.updateComposition({ durationSeconds })}
                onReviewConfiguration={createDraft.reviewConfiguration}
                onRemoveReference={createDraft.removeReference}
                onChangeReferenceRole={createDraft.setReferenceRole}
                onSubmit={() => { void createDraft.submit() }}
                onClose={() => createDraft.close()}
              />
            </ViewportPortal>
          ) : null}
          {selectedNode ? (
            <WorkspaceNodeDetailsCard
              node={selectedNode}
              actions={{
                busy: operationAction.busy || deleteAction.busy,
                onAssistantPrefill: requestAssistantDraft,
                onPreview: () => {
                  const card = selectedNode.data.kind === 'resourceCard'
                    ? selectedNode.data.resourceDetails
                    : null
                  if (!card) return
                  setPreview({
                    members: card.alternativeGroup?.members ?? [card],
                    initialResourceId: card.resource.resourceId,
                  })
                },
                onOperation: beginResourceOperation,
                onRegenerate: beginResourceRegeneration,
                onAnimate: beginAnimate,
                onUseAsReference: useSelectedAsReference,
                dropHighlighted: referenceDrop.activeTarget === 'details',
                referenceDrop: detailsReferenceDrop,
                onReferenceDropConsumed: consumeDetailsReferenceDrop,
                folderPath: currentFolderPath,
                onUploadedReference: (resourceId, reused) => {
                  // Same placement rule as "run again": section members are
                  // packed by their frame, only free cards get a neighbour pinned.
                  if (reused || selectedNode.parentId) return
                  pinResourcePositions([resourceId], {
                    x: selectedNode.position.x + selectedNode.data.width + REGENERATED_CARD_GAP_X,
                    y: selectedNode.position.y,
                  })
                },
                generationCapabilities,
              }}
            />
          ) : null}
          <MiniMap
            pannable
            zoomable
            position="bottom-left"
            bgColor="rgba(255,255,255,0.82)"
            maskColor="rgba(100,116,139,0.2)"
            maskStrokeColor="rgba(71,85,105,0.68)"
            nodeColor="rgba(148,163,184,0.7)"
            nodeStrokeColor="rgba(71,85,105,0.46)"
            nodeBorderRadius={10}
            offsetScale={0}
            className="!z-[60] !m-0 !overflow-hidden !rounded-[22px] !border-0 !bg-white/82 !shadow-lg !ring-1 !ring-[var(--glass-stroke-base)]/70 !backdrop-blur-2xl"
            style={{ left: 16, bottom: CANVAS_FLOATING_PANEL_BOTTOM_OFFSET_PX + 72, width: 180, height: 96 }}
          />
          <Panel
            position="bottom-left"
            className="!z-[70] !m-0"
            style={{ left: 16, bottom: CANVAS_FLOATING_PANEL_BOTTOM_OFFSET_PX + 16 }}
          >
            {arrangeFailed ? <p role="alert" className="rounded bg-white p-2 text-xs text-red-600">{t('toolbar.arrangeFailed')}</p> : null}
            <CanvasViewportControls
              arrangeLabel={t('toolbar.arrange')}
              arrangeDisabled={!projectionComplete || arranging}
              onArrange={() => { void arrangeLayout() }}
              fitViewLabel={t('toolbar.fitView')}
              zoomInLabel={t('toolbar.zoomIn')}
              zoomOutLabel={t('toolbar.zoomOut')}
              onFitView={fitView}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
            />
          </Panel>
        </ReactFlow>
        {multiSelection.marquee ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-[65] rounded-[6px] border border-sky-500/70 bg-sky-400/10"
            style={{
              left: multiSelection.marquee.left,
              top: multiSelection.marquee.top,
              width: multiSelection.marquee.width,
              height: multiSelection.marquee.height,
            }}
          />
        ) : null}
      </div>
      {loading || failed ? (
        <div className="pointer-events-none absolute inset-0 z-[75] flex items-center justify-center bg-[var(--glass-bg-canvas)]/45 backdrop-blur-[1px]">
          <div className="pointer-events-auto rounded-2xl bg-white px-5 py-4 text-sm text-[var(--glass-text-secondary)] shadow-lg ring-1 ring-[var(--glass-stroke-base)]">
            {failed ? (
              <div className="flex items-center gap-3">
                <span>{t('folderNavigation.loadFailed')}</span>
                <button
                  type="button"
                  className="font-semibold text-[var(--glass-text-primary)]"
                  onClick={() => {
                    void folderQuery.refetch()
                    if (layoutLoadError) void reloadLayout()
                  }}
                >
                  {t('folderNavigation.retry')}
                </button>
              </div>
            ) : t('folderNavigation.loading')}
          </div>
        </div>
      ) : null}
      {preview ? (
        <WorkspaceResourcePreviewModal
          members={preview.members}
          initialResourceId={preview.initialResourceId}
          onClose={() => setPreview(null)}
          onDiscuss={(card) => {
            const nextSelection = selectionForCard(card)
            if (nextSelection) onSelectionChange(nextSelection)
            setPreview(null)
            requestAssistantDraft(null)
          }}
        />
      ) : null}
      {operationAction.pending ? (
        <CanvasOperationConfirmationModal
          plan={operationAction.pending.plan}
          destructive={false}
          executing={operationAction.phase === 'executing'}
          onConfirm={() => { void operationAction.confirm() }}
          onCancel={operationAction.cancel}
        />
      ) : null}
      {deleteAction.pending ? (
        <CanvasOperationConfirmationModal
          plan={null}
          destructive
          destructiveTargets={deleteAction.pending.targets.map((target) => target.label)}
          executing={deleteAction.phase === 'executing'}
          onConfirm={() => { void deleteAction.confirm() }}
          onCancel={deleteAction.cancel}
        />
      ) : null}
      <CanvasUploadQueue items={uploadQueue.items} onRetry={uploadQueue.retry} onDismiss={uploadQueue.dismiss} />
      </div>
      </WorkspaceCanvasResourceSelectionContext.Provider>
    </WorkspaceCanvasFolderActionsContext.Provider>
  )
}

function ProjectWorkspaceCanvasContent(props: ProjectWorkspaceCanvasContentProps) {
  const t = useTranslations('projectWorkflow.canvas.workspace')
  const { projectId } = useWorkspaceProvider()
  const rootName = t('folderNavigation.root')
  const [folder, setFolder] = useState<CurrentCanvasFolder>({
    folderKey: WORKSPACE_RESOURCE_ROOT_FOLDER_KEY,
    name: rootName,
    workspacePath: '',
    ancestors: [],
  })
  const [pendingLocateResourceId, setPendingLocateResourceId] = useState<string | null>(null)
  const pathFocusQuery = useWorkspaceResourceByPath({
    projectId,
    workspacePath: props.workspacePathFocusRequest?.workspacePath ?? null,
    enabled: Boolean(props.workspacePathFocusRequest),
    refreshToken: props.workspacePathFocusRequest?.requestId ?? null,
  })
  const handledPathFocusRequestId = useRef<string | null>(null)
  const navigate = useCallback((nextFolder: CurrentCanvasFolder, locateResourceId: string | null = null) => {
    props.onSelectionChange(null)
    setPendingLocateResourceId(locateResourceId)
    setFolder(nextFolder)
  }, [props])
  useEffect(() => {
    const request = props.workspacePathFocusRequest
    if (!request || pathFocusQuery.isLoading || handledPathFocusRequestId.current === request.requestId) return
    const resource = pathFocusQuery.data
    handledPathFocusRequestId.current = request.requestId
    if (!resource) return
    if (resource.resourceKind === 'folder') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Consume the external path-focus request after its resource has loaded.
      navigate(folderFromResource(resource))
      return
    }
    navigate(parentFolderFromResource(resource, rootName), resource.resourceId)
  }, [navigate, pathFocusQuery.data, pathFocusQuery.isLoading, props.workspacePathFocusRequest, rootName])
  return (
    <ProjectWorkspaceFolderCanvas
      key={folder.folderKey}
      {...props}
      folder={folder}
      rootName={rootName}
      pendingLocateResourceId={pendingLocateResourceId}
      onNavigate={navigate}
      onLocateConsumed={() => setPendingLocateResourceId(null)}
    />
  )
}

export default function ProjectWorkspaceCanvas(props: ProjectWorkspaceCanvasContentProps) {
  return (
    <ReactFlowProvider>
      <ProjectWorkspaceCanvasContent {...props} />
    </ReactFlowProvider>
  )
}
