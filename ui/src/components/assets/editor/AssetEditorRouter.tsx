import { Agent, FSRef, Skill, TypeId, VFSPath, Whiteboard, Workflow } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { RefreshCw } from 'lucide-react';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor, AssetRoutingMethod, EDITOR_TYPES, editorForType } from '@src/navigation/asset-doc-types';
import { EntityResolutionGate } from './EntityResolutionGate';
import { PlainMarkdownAssetEditor } from './markdown/PlainMarkdownAssetEditor';
import { SkillAssetEditor } from './skill/SkillAssetEditor';
import { AgentAssetEditor } from './agent/AgentAssetEditor';
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

  // Derive the FSRef + the record type for this asset.
  let fsRef: FSRef | null = null;
  let assetType: string;
  if (ptr.method === AssetRoutingMethod.TYPEID) {
    if (!typeIdEntity) return <ConnectingFallback />;
    const e = typeIdEntity as { asset_ref?: string };
    // Build the FSRef from the entity's canonical asset_ref (the path the
    // editors' EntityResolutionGate matches on — the folder for skill/whiteboard,
    // the .md for agent/markdown). Editors derive their own inner doc.
    fsRef =
      e.asset_ref && computeNode?.typeId
        ? new FSRef(e.asset_ref.replace(/^\//, ''), computeNode.typeId)
        : null;
    assetType = typeId!.type;
  } else {
    const vfs = VFSPath.parse(ptr.value);
    if (!vfs.typeId) return <ConnectingFallback />;
    fsRef = new FSRef(vfs.entitySubPath, vfs.typeId);
    // vfs lost the precise record type; fall back to the editor's primary type.
    assetType = (EDITOR_TYPES[ptr.editor][0] as string | undefined) ?? ptr.editor;
  }

  if (!fsRef) return <ConnectingFallback />;

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
