import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { MarkdownAssetEditor } from '@src/components/assets/editor/markdown/MarkdownAssetEditor';
import { AssetExecutionPanel } from '@src/components/assets/execution-panel/AssetExecutionPanel';
import { AgentToolbar, useAgentExecution } from './AgentToolbar';

interface AgentAssetEditorProps {
  /** Absolute machine path to the agent .md file */
  sourcePath: string;
}

/**
 * Agent asset editor with a Run toolbar button and streaming execution panel.
 *
 * - toolbar slot: AgentToolbar (Run/Stop button)
 * - execution panel: slides in when Run is clicked, shows streamed agent output
 */
export function AgentAssetEditor({ sourcePath }: AgentAssetEditorProps) {
  const { computeNode } = useAgentContext();
  const execution = useAgentExecution(sourcePath);

  if (!computeNode?.typeId) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <MarkdownAssetEditor
        sourcePath={sourcePath}
        toolbar={<AgentToolbar execution={execution} />}
      />
      {execution.panelOpen && (
        <AssetExecutionPanel
          execution={execution}
          onClose={() => execution.setPanelOpen(false)}
        />
      )}
    </div>
  );
}
