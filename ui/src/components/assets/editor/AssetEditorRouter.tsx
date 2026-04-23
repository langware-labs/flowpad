import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { FSRef, RecordType } from '@sdk';
import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
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
      return <SkillAssetEditor fsRef={fsRef} />;
    case RecordType.AGENT:
      return <AgentAssetEditor fsRef={fsRef} />;
    case 'workflow':
      return <WorkflowAssetEditor fsRef={fsRef} />;
    case RecordType.MARKDOWN:
    case RecordType.CLAUDE_MD:
    case 'claude_memory':
    case 'claude_rules':
    case RecordType.COMMAND:
    case RecordType.PLAN:
      return <PlainMarkdownAssetEditor fsRef={fsRef} assetType={assetType} />;
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No editor for type: {assetType}
        </div>
      );
  }
}
