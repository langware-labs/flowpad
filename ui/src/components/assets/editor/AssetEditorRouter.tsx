import { Agent, AgentTrace, FSRef, Skill, TypeId, VFSPath, Whiteboard, Workflow } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor, AssetRoutingMethod, EDITOR_TYPES, editorForType } from '@src/navigation/asset-doc-types';
import { EntityResolutionGate } from './EntityResolutionGate';
import { PlainMarkdownAssetEditor } from './markdown/PlainMarkdownAssetEditor';
import { SkillAssetEditor } from './skill/SkillAssetEditor';
import { AgentAssetEditor } from './agent/AgentAssetEditor';
import { AgentTraceAssetEditor } from './agent-trace/AgentTraceAssetEditor';
import { WhiteboardAssetEditor } from './whiteboard/WhiteboardAssetEditor';
import { WorkflowAssetEditor } from './workflow/WorkflowAssetEditor';

interface AssetEditorRouterProps {
  /** The ViewType.ASSETS pointer, e.g. "editor/<editor>/<method>/<value>". */
  pointer: string;
}

/** True if `assetType` (a RecordType value) has an asset editor. */
export function hasEditor(assetType: string): boolean {
  return editorForType(assetType) !== undefined;
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
  const { data: typeIdEntity } = useEntity(typeId);
  const { computeNode } = useAgentContext();

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
    if (!ptr || !ptr.editor || ptr.editor === AssetEditor.CODE) return null;
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
    case AssetEditor.AGENT_TRACE:
      return (
        <EntityResolutionGate<AgentTrace>
          type={AgentTrace.type}
          fsRef={fsRef}
          typeLabel="agent trace"
          render={(trace) => <AgentTraceAssetEditor fsRef={fsRef!} trace={trace} />}
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
