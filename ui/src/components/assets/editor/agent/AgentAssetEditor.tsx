import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { MarkdownAssetEditor } from '@src/components/assets/editor/markdown/MarkdownAssetEditor';

interface AgentAssetEditorProps {
  /** Absolute machine path to the agent .md file */
  sourcePath: string;
}

/**
 * Thin wrapper around MarkdownAssetEditor for agent assets.
 *
 * The agent's source_path IS the .md file (unlike skills, which point to a folder).
 * No path transformation needed — passes sourcePath directly to the generic editor.
 */
export function AgentAssetEditor({ sourcePath }: AgentAssetEditorProps) {
  const { computeNode } = useAgentContext();
  if (!computeNode?.typeId) return null;
  return <MarkdownAssetEditor sourcePath={sourcePath} />;
}
