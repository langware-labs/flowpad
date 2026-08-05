import {
  Agent,
  SubAgent,
  AgentTrace,
  APIEntity,
  AssetCleanupReport,
  dataManager,
  Deck,
  DeckTemplate,
  DynamicWorkflow,
  FSRef,
  Journey,
  Skill,
  Spreadsheet,
  Task,
  TypeId,
  UsageReport,
  VFSPath,
  Whiteboard,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { lazy, Suspense, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import {
  AssetEditor,
  AssetRoutingMethod,
  EDITOR_TYPES,
  editorForType,
  isFileOnlyEditor,
} from '@src/navigation/asset-doc-types';
import { HtmlPreview } from '@src/components/html-preview/HtmlPreview';
import { MediaViewer } from '@src/components/media-viewer/MediaViewer';
import { PdfViewer } from '@src/components/pdf-viewer/PdfViewer';
import { EntityResolutionGate } from './EntityResolutionGate';
import { MissingAssetCard } from './MissingAssetCard';
import { PlainMarkdownAssetEditor } from './markdown/PlainMarkdownAssetEditor';
import type { WikiLinkTarget } from './markdown/MarkdownEditor';
import { SkillAssetEditor } from './skill/SkillAssetEditor';
import { TaskAssetEditor } from './task/TaskAssetEditor';
import { AgentProfileEditor } from './agent-profile/AgentProfileEditor';
import { SubAgentAssetEditor } from './subagent/SubAgentAssetEditor';
import { AgentTraceAssetEditor } from './agent-trace/AgentTraceAssetEditor';
import { DynamicWorkflowAssetEditor } from './dynamic-workflow/DynamicWorkflowAssetEditor';
import { UsageReportAssetEditor } from './usage-report/UsageReportAssetEditor';
import { AssetCleanupReportAssetEditor } from './asset-cleanup/AssetCleanupReportAssetEditor';
import { JourneyViewer } from '@src/journey/JourneyViewer';
import { WhiteboardAssetEditor } from './whiteboard/WhiteboardAssetEditor';
import { DeckTemplateViewer } from './deck-template/DeckTemplateViewer';
import { DeckViewer } from './deck/DeckViewer';
import { AssetCollisionProvider, AssetCollisionShell } from './AssetCollisionUI';

const McpAppPreview = lazy(() =>
  import('@src/components/mcp-app-preview/McpAppPreview').then((m) => ({ default: m.McpAppPreview })),
);
const SpreadsheetAssetEditor = lazy(() =>
  import('./spreadsheet/SpreadsheetAssetEditor').then((m) => ({ default: m.SpreadsheetAssetEditor })),
);

interface AssetEditorRouterProps {
  /** The ViewType.ASSETS pointer, e.g. "editor/<editor>/<method>/<value>". */
  pointer: string;
  /** Optional heading slug for a Wiki target rendered at its Wiki URL. */
  fragment?: string;
  /** Reflect entity-record reads to Hub while preserving the normal editor UI. */
  hubReflect?: boolean;
  /** Keep links inside Wiki-rendered documents on the same page and namespace. */
  wikiLinkTarget?: WikiLinkTarget;
}

/** True if `assetType` (a RecordType value) has an asset editor. */
export function hasEditor(assetType: string): boolean {
  return editorForType(assetType) !== undefined;
}

/** vpath (`compute_node-@local/<rel>`) → machine abs path; passthrough otherwise. */
function machinePathOf(value: string): string {
  const vfs = VFSPath.parse(value);
  return vfs.typeId ? vfs.machinePath : value;
}

function ConnectingFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      Connecting…
    </div>
  );
}

/**
 * Routes an `AssetDocPointer` (editor mode) to the right editor component.
 *
 * The routing-method segment is explicit, so the target is resolved without
 * guessing: `typeid` → load the entity (its `.doc` is the FSRef); `vfs` → build
 * the FSRef straight from the compute-node-rooted path; `code` → raw CodeEditor.
 * Editors resolve/refresh the backing entity off the FSRef themselves.
 */
export function AssetEditorRouter({ pointer, fragment, hubReflect = false, wikiLinkTarget }: AssetEditorRouterProps) {
  const ptr = (() => {
    try {
      const p = AssetDocPointer.parse(pointer);
      p.validate();
      return p;
    } catch {
      return null;
    }
  })();

  // Hooks must run unconditionally — resolve the typeid entity (null otherwise).
  const typeId =
    ptr && ptr.editor !== AssetEditor.CODE && ptr.method === AssetRoutingMethod.TYPEID ? new TypeId(ptr.value) : null;
  const {
    data: typeIdEntity,
    isLoading: entityLoading,
    isError: entityError,
    refetch: refetchEntity,
  } = useEntity(typeId);
  const { computeNode, flow } = useAgentContext();
  const {
    data: entityRecord,
    isLoading: recordLoading,
    isError: recordError,
    refetch: refetchRecord,
  } = useQuery({
    queryKey: ['asset-record-refs', hubReflect ? 'hub' : 'local', typeId?.toString()],
    queryFn: () => typeIdEntity!.record({ hubReflect }),
    enabled: !!typeIdEntity && ptr?.method === AssetRoutingMethod.TYPEID,
  });

  // Derive the FSRef + the record type for this asset in ONE unconditional memo
  // (must run before the early returns to keep hook order stable). The FSRef is
  // keyed on its STABLE string inputs (the pointer + resolved asset_ref + compute
  // -node id) rather than rebuilt every render — a fresh object each render would
  // churn the identity of every downstream hook keyed on it (useEntityByPath via
  // EntityResolutionGate, useAssetRevisionStatus, the editors' content load),
  // which a backend-scan WS flood turns into a per-frame reload (the "flicker").
  const mainRef = entityRecord?.mainRef ?? null;
  const computeNodeKey = computeNode?.typeId?.toString() ?? null;
  const derived = useMemo<{ fsRef: FSRef; assetType: string; mainFileRef: FSRef } | null>(() => {
    if (!ptr || !ptr.editor || isFileOnlyEditor(ptr.editor)) return null;
    if (ptr.method === AssetRoutingMethod.TYPEID) {
      // The entity owns its content layout. record/refs carries both the path
      // and the filesystem authority, so this works for local mounts and Hub
      // entity storage without a compute-node or sender-local asset_ref.
      if (!mainRef) return null;
      return {
        fsRef: recordContentRef(mainRef, !!dataManager.getTypeInfo(typeId!.type)?.folder_backed),
        assetType: typeId!.type,
        mainFileRef: mainRef,
      };
    }
    const vfs = VFSPath.parse(ptr.value);
    if (!vfs.typeId) return null;
    const vfsRef = new FSRef(vfs.entitySubPath, vfs.typeId);
    return {
      fsRef: vfsRef,
      // vfs lost the precise record type; fall back to the editor's primary type.
      assetType: (EDITOR_TYPES[ptr.editor][0] as string | undefined) ?? ptr.editor,
      // record/refs is TYPEID-only, so `mainRef` is null on this route. A vfs
      // pointer names the asset's own file, so it IS the main ref — editors
      // that write the main file (agent.md) must use this, not `mainRef`.
      mainFileRef: vfsRef,
    };
    // ptr/typeId are derived deterministically from `pointer`; keying on the
    // stable strings keeps the memo from re-minting the FSRef every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointer, mainRef, computeNodeKey]);

  if (!ptr || !ptr.editor) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Invalid asset pointer</div>
    );
  }

  // code: file-only, no entity. CodeEditor parses the compute-node-rooted path.
  if (ptr.editor === AssetEditor.CODE) {
    return <CodeEditor activePath={ptr.value} />;
  }

  // File-only display viewers: no entity, no EntityResolutionGate. HtmlPreview
  // and McpAppPreview expect a machine abs path (they prefix the context
  // compute node themselves), so normalize the pointer value here — the ONE
  // vpath→machine-path point for these viewers. MediaViewer parses both forms.
  if (ptr.editor === AssetEditor.HTML) {
    return <HtmlPreview path={machinePathOf(ptr.value)} />;
  }
  if (ptr.editor === AssetEditor.MCP_APP) {
    return (
      <Suspense fallback={<ConnectingFallback />}>
        <McpAppPreview path={machinePathOf(ptr.value)} process={flow ?? null} />
      </Suspense>
    );
  }
  if (ptr.editor === AssetEditor.IMAGE || ptr.editor === AssetEditor.VIDEO || ptr.editor === AssetEditor.AUDIO) {
    // The enum values ARE the kind strings ('image' | 'video' | 'audio').
    return <MediaViewer path={ptr.value} kind={ptr.editor} />;
  }
  if (ptr.editor === AssetEditor.PDF) {
    // PdfViewer parses both the vpath and plain-path forms itself, like MediaViewer.
    return <PdfViewer path={ptr.value} />;
  }

  // A typeid pointer whose entity has SETTLED with nothing usable (404 /
  // fetch error / resolved-but-no-main-ref — e.g. a tab pointing at a
  // markdown that was never materialized) is terminal, not "still
  // connecting". Surface the shared missing-asset card instead of spinning
  // forever — the `!derived` guard below otherwise conflates this with the
  // genuine loading state. (Only the loading window keeps the spinner.)
  if (
    typeId &&
    ptr.method === AssetRoutingMethod.TYPEID &&
    !entityLoading &&
    !recordLoading &&
    (entityError || recordError || !mainRef)
  ) {
    // owns_main_ref types (task/spec) re-render their backing file from the
    // default body on save, so an orphaned row (no asset_ref / file gone — e.g.
    // a task created before this checkout was a folder asset) can self-heal
    // with one save. Offer that; hand-edited types (markdown/skill) get retry
    // only, since rebuilding from a template would clobber user content.
    const ownsMainRef = !!dataManager.getAllTypeInfos?.().find((t) => t.type_name === typeId.type)?.owns_main_ref;
    const orphan = typeIdEntity as APIEntity<never> | null;
    return (
      <MissingAssetCard
        typeLabel={typeId.type}
        fsRef={new FSRef(typeId.toString(), computeNode?.typeId ?? typeId)}
        onRetry={() => {
          void refetchEntity();
          void refetchRecord();
        }}
        entity={typeIdEntity ?? null}
        onRebuild={ownsMainRef && orphan ? () => void orphan.save().then(() => refetchEntity()) : undefined}
      />
    );
  }

  if (!derived) return <ConnectingFallback />;
  const { fsRef, assetType, mainFileRef } = derived;

  switch (ptr.editor) {
    case AssetEditor.SKILL:
      return (
        <EntityResolutionGate<Skill>
          type={Skill.type}
          fsRef={fsRef}
          typeLabel="skill"
          resolvedEntity={typeIdEntity as Skill | undefined}
          render={(skill) => (
            <AssetCollisionProvider entity={skill}>
              <SkillAssetEditor fsRef={fsRef} skill={skill} wikiLinkTarget={wikiLinkTarget} />
            </AssetCollisionProvider>
          )}
        />
      );
    case AssetEditor.TASK:
      return (
        <EntityResolutionGate<Task>
          type={Task.type}
          fsRef={fsRef}
          typeLabel="task"
          resolvedEntity={typeIdEntity as Task | undefined}
          render={(task) => (
            <AssetCollisionShell entity={task}>
              <TaskAssetEditor fsRef={fsRef} task={task} />
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.SUBAGENT:
      return (
        <EntityResolutionGate<SubAgent>
          type={SubAgent.type}
          fsRef={fsRef}
          typeLabel="sub-agent"
          resolvedEntity={typeIdEntity as SubAgent | undefined}
          render={(subagent) => (
            <AssetCollisionProvider entity={subagent}>
              <SubAgentAssetEditor fsRef={fsRef} agent={subagent} wikiLinkTarget={wikiLinkTarget} />
            </AssetCollisionProvider>
          )}
        />
      );
    case AssetEditor.AGENT:
      return (
        <EntityResolutionGate<Agent>
          type={Agent.type}
          fsRef={fsRef}
          typeLabel="agent"
          resolvedEntity={typeIdEntity as Agent | undefined}
          render={(agent) => (
            <AssetCollisionShell entity={agent}>
              <AgentProfileEditor agent={agent} mainRef={mainFileRef} onSaved={() => refetchEntity()} />
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.WHITEBOARD:
      return (
        <EntityResolutionGate<Whiteboard>
          type={Whiteboard.type}
          fsRef={fsRef}
          typeLabel="whiteboard"
          resolvedEntity={typeIdEntity as Whiteboard | undefined}
          render={(whiteboard) => (
            <AssetCollisionShell entity={whiteboard}>
              <WhiteboardAssetEditor fsRef={fsRef} whiteboard={whiteboard} />
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.DECK_TEMPLATE:
      return (
        <EntityResolutionGate<DeckTemplate>
          type={DeckTemplate.type}
          fsRef={fsRef}
          typeLabel="deck template"
          resolvedEntity={typeIdEntity as DeckTemplate | undefined}
          render={(deckTemplate) => (
            <AssetCollisionShell entity={deckTemplate}>
              <DeckTemplateViewer fsRef={fsRef} deckTemplate={deckTemplate} />
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.DECK:
      return (
        <EntityResolutionGate<Deck>
          type={Deck.type}
          fsRef={fsRef}
          typeLabel="deck"
          resolvedEntity={typeIdEntity as Deck | undefined}
          render={(deck) => (
            <AssetCollisionShell entity={deck}>
              <DeckViewer fsRef={fsRef} deck={deck} />
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.JOURNEY:
      return (
        <EntityResolutionGate<Journey>
          type={Journey.type}
          fsRef={fsRef}
          typeLabel="journey"
          resolvedEntity={typeIdEntity as Journey | undefined}
          render={(journey) => <JourneyViewer journey={journey} />}
        />
      );
    case AssetEditor.SPREADSHEET:
      return (
        <EntityResolutionGate<Spreadsheet>
          type={Spreadsheet.type}
          fsRef={fsRef}
          typeLabel="spreadsheet"
          resolvedEntity={typeIdEntity as Spreadsheet | undefined}
          render={(spreadsheet) => (
            <AssetCollisionShell entity={spreadsheet}>
              <Suspense fallback={<ConnectingFallback />}>
                <SpreadsheetAssetEditor fsRef={fsRef} spreadsheet={spreadsheet} />
              </Suspense>
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.AGENT_TRACE:
      return (
        <EntityResolutionGate<AgentTrace>
          type={AgentTrace.type}
          fsRef={fsRef}
          typeLabel="agent trace"
          resolvedEntity={typeIdEntity as AgentTrace | undefined}
          render={(trace) => (
            <AssetCollisionShell entity={trace}>
              <AgentTraceAssetEditor fsRef={fsRef} trace={trace} />
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.DYNAMIC_WORKFLOW:
      return (
        <EntityResolutionGate<DynamicWorkflow>
          type={DynamicWorkflow.type}
          fsRef={fsRef}
          typeLabel="dynamic workflow"
          resolvedEntity={typeIdEntity as DynamicWorkflow | undefined}
          render={(workflow) => (
            <AssetCollisionShell entity={workflow}>
              <DynamicWorkflowAssetEditor fsRef={fsRef} workflow={workflow} />
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.USAGE_REPORT:
      return (
        <EntityResolutionGate<UsageReport>
          type={UsageReport.type}
          fsRef={fsRef}
          typeLabel="usage report"
          resolvedEntity={typeIdEntity as UsageReport | undefined}
          render={(report) => (
            <AssetCollisionShell entity={report}>
              <UsageReportAssetEditor fsRef={fsRef} report={report} />
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.ASSET_CLEANUP_REPORT:
      return (
        <EntityResolutionGate<AssetCleanupReport>
          type={AssetCleanupReport.type}
          fsRef={fsRef}
          typeLabel="asset cleanup report"
          resolvedEntity={typeIdEntity as AssetCleanupReport | undefined}
          render={(report) => (
            <AssetCollisionShell entity={report}>
              <AssetCleanupReportAssetEditor fsRef={fsRef} report={report} />
            </AssetCollisionShell>
          )}
        />
      );
    case AssetEditor.MARKDOWN:
      // Markdown family (markdown, claude_md, claude_memory, claude_rules,
      // command, plan) is intentionally NOT gated — a raw file may have no
      // first-class entity; PlainMarkdownAssetEditor tolerates entity=null.
      return (
        <PlainMarkdownAssetEditor
          fsRef={fsRef}
          assetType={assetType}
          resolvedEntity={typeIdEntity as APIEntity<APIEntity<any>> | undefined}
          fragment={fragment}
          wikiLinkTarget={wikiLinkTarget}
        />
      );
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No editor for: {ptr.editor}
        </div>
      );
  }
}
/** Resolve the content root from the backend type registry's layout contract.
 * Folder-backed records expose a primary file, but their editor owns its
 * sibling files too, so the editor receives that file's containing folder. */
export function recordContentRef(mainRef: FSRef, folderBacked: boolean): FSRef {
  if (folderBacked && mainRef.refType !== 'folder') {
    return mainRef.parent;
  }
  return mainRef;
}
