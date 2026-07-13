import { Agent, AgentTrace, APIEntity, AssetCleanupReport, dataManager, DeckTemplate, DynamicWorkflow, FSRef, Skill, Task, TypeId, UsageReport, VFSPath, Whiteboard, Workflow } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor, AssetRoutingMethod, EDITOR_TYPES, editorForType, isFileOnlyEditor } from '@src/navigation/asset-doc-types';
import { HtmlPreview } from '@src/components/html-preview/HtmlPreview';
import { McpAppPreview } from '@src/components/mcp-app-preview/McpAppPreview';
import { MediaViewer } from '@src/components/media-viewer/MediaViewer';
import { PdfViewer } from '@src/components/pdf-viewer/PdfViewer';
import { EntityResolutionGate } from './EntityResolutionGate';
import { MissingAssetCard } from './MissingAssetCard';
import { PlainMarkdownAssetEditor } from './markdown/PlainMarkdownAssetEditor';
import { SkillAssetEditor } from './skill/SkillAssetEditor';
import { TaskAssetEditor } from './task/TaskAssetEditor';
import { AgentAssetEditor } from './agent/AgentAssetEditor';
import { AgentTraceAssetEditor } from './agent-trace/AgentTraceAssetEditor';
import { DynamicWorkflowAssetEditor } from './dynamic-workflow/DynamicWorkflowAssetEditor';
import { UsageReportAssetEditor } from './usage-report/UsageReportAssetEditor';
import { AssetCleanupReportAssetEditor } from './asset-cleanup/AssetCleanupReportAssetEditor';
import { WhiteboardAssetEditor } from './whiteboard/WhiteboardAssetEditor';
import { DeckTemplateViewer } from './deck-template/DeckTemplateViewer';
import { WorkflowAssetEditor } from './workflow/WorkflowAssetEditor';

interface AssetEditorRouterProps {
  /** The ViewType.ASSETS pointer, e.g. "editor/<editor>/<method>/<value>". */
  pointer: string;
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
export function AssetEditorRouter({ pointer }: AssetEditorRouterProps) {
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
    ptr && ptr.editor !== AssetEditor.CODE && ptr.method === AssetRoutingMethod.TYPEID
      ? new TypeId(ptr.value)
      : null;
  const { data: typeIdEntity, isLoading: entityLoading, isError: entityError, refetch: refetchEntity } = useEntity(typeId);
  const { computeNode, flow } = useAgentContext();

  // Derive the FSRef + the record type for this asset in ONE unconditional memo
  // (must run before the early returns to keep hook order stable). The FSRef is
  // keyed on its STABLE string inputs (the pointer + resolved asset_ref + compute
  // -node id) rather than rebuilt every render — a fresh object each render would
  // churn the identity of every downstream hook keyed on it (useEntityByPath via
  // EntityResolutionGate, useAssetRevisionStatus, the editors' content load),
  // which a backend-scan WS flood turns into a per-frame reload (the "flicker").
  const assetRef = (typeIdEntity as { asset_ref?: string } | null)?.asset_ref ?? null;
  const computeNodeKey = computeNode?.typeId?.toString() ?? null;
  const derived = useMemo<{ fsRef: FSRef; assetType: string } | null>(() => {
    if (!ptr || !ptr.editor || isFileOnlyEditor(ptr.editor)) return null;
    if (ptr.method === AssetRoutingMethod.TYPEID) {
      // Build the FSRef from the entity's canonical asset_ref (the path the
      // editors' EntityResolutionGate matches on — the folder for skill/whiteboard,
      // the .md for agent/markdown). Editors derive their own inner doc.
      if (!assetRef || !computeNode?.typeId) return null;
      return {
        fsRef: new FSRef(assetRef.replace(/^\//, ''), computeNode.typeId),
        assetType: typeId!.type,
      };
    }
    const vfs = VFSPath.parse(ptr.value);
    if (!vfs.typeId) return null;
    return {
      fsRef: new FSRef(vfs.entitySubPath, vfs.typeId),
      // vfs lost the precise record type; fall back to the editor's primary type.
      assetType: (EDITOR_TYPES[ptr.editor][0] as string | undefined) ?? ptr.editor,
    };
    // ptr/typeId are derived deterministically from `pointer`; keying on the
    // stable strings keeps the memo from re-minting the FSRef every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointer, assetRef, computeNodeKey]);

  if (!ptr || !ptr.editor) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Invalid asset pointer
      </div>
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
    return <McpAppPreview path={machinePathOf(ptr.value)} process={flow ?? null} />;
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
  // fetch error / resolved-but-no-asset_ref — e.g. a tab pointing at a
  // markdown that was never materialized) is terminal, not "still
  // connecting". Surface the shared missing-asset card instead of spinning
  // forever — the `!derived` guard below otherwise conflates this with the
  // genuine loading state. (Only the loading window keeps the spinner.)
  if (
    typeId &&
    ptr.method === AssetRoutingMethod.TYPEID &&
    !entityLoading &&
    (entityError || !assetRef)
  ) {
    // owns_main_ref types (task/spec) re-render their backing file from the
    // default body on save, so an orphaned row (no asset_ref / file gone — e.g.
    // a task created before this checkout was a folder asset) can self-heal
    // with one save. Offer that; hand-edited types (markdown/skill) get retry
    // only, since rebuilding from a template would clobber user content.
    const ownsMainRef = !!dataManager
      .getAllTypeInfos?.()
      .find((t) => t.type_name === typeId.type)?.owns_main_ref;
    const orphan = typeIdEntity as APIEntity<never> | null;
    return (
      <MissingAssetCard
        typeLabel={typeId.type}
        fsRef={new FSRef(typeId.toString(), computeNode?.typeId ?? typeId)}
        onRetry={() => void refetchEntity()}
        entity={typeIdEntity ?? null}
        onRebuild={
          ownsMainRef && orphan
            ? () => void orphan.save().then(() => refetchEntity())
            : undefined
        }
      />
    );
  }

  if (!derived) return <ConnectingFallback />;
  const { fsRef, assetType } = derived;

  switch (ptr.editor) {
    case AssetEditor.SKILL:
      return (
        <EntityResolutionGate<Skill>
          type={Skill.type}
          fsRef={fsRef}
          typeLabel="skill"
          render={(skill) => <SkillAssetEditor fsRef={fsRef!} skill={skill} />}
        />
      );
    case AssetEditor.TASK:
      return (
        <EntityResolutionGate<Task>
          type={Task.type}
          fsRef={fsRef}
          typeLabel="task"
          render={(task) => <TaskAssetEditor fsRef={fsRef!} task={task} />}
        />
      );
    case AssetEditor.AGENT:
      return (
        <EntityResolutionGate<Agent>
          type={Agent.type}
          fsRef={fsRef}
          typeLabel="agent"
          render={(agent) => <AgentAssetEditor fsRef={fsRef!} agent={agent} />}
        />
      );
    case AssetEditor.WHITEBOARD:
      return (
        <EntityResolutionGate<Whiteboard>
          type={Whiteboard.type}
          fsRef={fsRef}
          typeLabel="whiteboard"
          render={(whiteboard) => <WhiteboardAssetEditor fsRef={fsRef!} whiteboard={whiteboard} />}
        />
      );
    case AssetEditor.DECK_TEMPLATE:
      return (
        <EntityResolutionGate<DeckTemplate>
          type={DeckTemplate.type}
          fsRef={fsRef}
          typeLabel="deck template"
          render={(deckTemplate) => (
            <DeckTemplateViewer fsRef={fsRef} deckTemplate={deckTemplate} />
          )}
        />
      );
    case AssetEditor.AGENT_TRACE:
      return (
        <EntityResolutionGate<AgentTrace>
          type={AgentTrace.type}
          fsRef={fsRef}
          typeLabel="agent trace"
          render={(trace) => <AgentTraceAssetEditor fsRef={fsRef!} trace={trace} />}
        />
      );
    case AssetEditor.DYNAMIC_WORKFLOW:
      return (
        <EntityResolutionGate<DynamicWorkflow>
          type={DynamicWorkflow.type}
          fsRef={fsRef}
          typeLabel="dynamic workflow"
          render={(workflow) => <DynamicWorkflowAssetEditor fsRef={fsRef!} workflow={workflow} />}
        />
      );
    case AssetEditor.USAGE_REPORT:
      return (
        <EntityResolutionGate<UsageReport>
          type={UsageReport.type}
          fsRef={fsRef}
          typeLabel="usage report"
          render={(report) => <UsageReportAssetEditor fsRef={fsRef!} report={report} />}
        />
      );
    case AssetEditor.ASSET_CLEANUP_REPORT:
      return (
        <EntityResolutionGate<AssetCleanupReport>
          type={AssetCleanupReport.type}
          fsRef={fsRef}
          typeLabel="asset cleanup report"
          render={(report) => <AssetCleanupReportAssetEditor fsRef={fsRef!} report={report} />}
        />
      );
    case AssetEditor.WORKFLOW:
      return (
        <EntityResolutionGate<Workflow>
          type={Workflow.type}
          fsRef={fsRef}
          typeLabel="workflow"
          render={(workflow) => <WorkflowAssetEditor fsRef={fsRef!} workflow={workflow} />}
        />
      );
    case AssetEditor.MARKDOWN:
      // Markdown family (markdown, claude_md, claude_memory, claude_rules,
      // command, plan) is intentionally NOT gated — a raw file may have no
      // first-class entity; PlainMarkdownAssetEditor tolerates entity=null.
      return <PlainMarkdownAssetEditor fsRef={fsRef} assetType={assetType} />;
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No editor for: {ptr.editor}
        </div>
      );
  }
}
