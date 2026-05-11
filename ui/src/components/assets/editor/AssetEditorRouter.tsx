import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { Agent, FSRef, RecordType, Skill, Workflow } from '@sdk';
import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { EntityResolutionGate } from './EntityResolutionGate';
import { PlainMarkdownAssetEditor } from './markdown/PlainMarkdownAssetEditor';
import { SkillAssetEditor } from './skill/SkillAssetEditor';
import { AgentAssetEditor } from './agent/AgentAssetEditor';
import { WorkflowAssetEditor } from './workflow/WorkflowAssetEditor';

interface AssetEditorRouterProps {
  /** Pointer in the format "editor/<type>/<vfsSubPath>" */
  pointer: string;
}

/**
 * Routes an asset editor pointer to the appropriate type-specific editor.
 *
 * Pointer format: "editor/<assetType>/<vfsSubPath...>"
 * vfsSubPath is a VFS entity sub-path (no leading '/') — e.g.:
 *   "editor/skill/Users/shlom/.claude/skills/my-skill"
 *   "editor/agent/Users/shlom/.claude/agents/enricher.md"
 *
 * The router does the string → FSRef conversion once and passes FSRef
 * directly to each editor. Editors never reconstruct paths.
 */
const EDITABLE_TYPES = new Set<string>([
  RecordType.SKILL, RecordType.MARKDOWN, RecordType.AGENT,
  RecordType.CLAUDE_MD, 'claude_memory', 'claude_rules',
  RecordType.COMMAND, RecordType.PLAN, 'workflow',
  // Projects don't open in the editor — clicking a project row redirects to
  // its collaboration space (handled at the click site). Listed here so the
  // row stays clickable.
  RecordType.PROJECT,
]);

export function hasEditor(assetType: string): boolean {
  return EDITABLE_TYPES.has(assetType);
}

function ConnectingFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      Connecting…
    </div>
  );
}

export function AssetEditorRouter({ pointer }: AssetEditorRouterProps) {
  const { computeNode } = useAgentContext();
  const [, assetType = '', ...rest] = pointer.split('/');
  const vfsSubPath = rest.join('/');
  const typeIdStr = computeNode?.typeId?.toString();

  const fsRef = useMemo(
    () => (computeNode?.typeId ? new FSRef(vfsSubPath, computeNode.typeId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typeIdStr, vfsSubPath],
  );

  if (!fsRef) return <ConnectingFallback />;

  switch (assetType) {
    case RecordType.SKILL:
      return (
        <EntityResolutionGate<Skill>
          type={Skill.type}
          fsRef={fsRef}
          typeLabel="skill"
          render={(skill) => <SkillAssetEditor fsRef={fsRef} skill={skill} />}
        />
      );
    case RecordType.AGENT:
      return (
        <EntityResolutionGate<Agent>
          type={Agent.type}
          fsRef={fsRef}
          typeLabel="agent"
          render={(agent) => <AgentAssetEditor fsRef={fsRef} agent={agent} />}
        />
      );
    case 'workflow':
      return (
        <EntityResolutionGate<Workflow>
          type={Workflow.type}
          fsRef={fsRef}
          typeLabel="workflow"
          render={(workflow) => <WorkflowAssetEditor fsRef={fsRef} workflow={workflow} />}
        />
      );
    case RecordType.MARKDOWN:
    case RecordType.CLAUDE_MD:
    case 'claude_memory':
    case 'claude_rules':
    case RecordType.COMMAND:
    case RecordType.PLAN:
      // Plain markdown is intentionally NOT wrapped in EntityResolutionGate.
      // Files like a raw `CLAUDE.md` may have no backing first-class entity,
      // and `PlainMarkdownAssetEditor` already tolerates `entity=null` (the
      // Run button just disables with a "no backing entity" tooltip). Wrapping
      // here would regress to a missing-asset card for those files.
      return <PlainMarkdownAssetEditor fsRef={fsRef} assetType={assetType} />;
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No editor for type: {assetType}
        </div>
      );
  }
}
