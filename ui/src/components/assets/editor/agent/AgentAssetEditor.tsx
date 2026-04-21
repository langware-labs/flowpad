import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { AssetExecutionPanel } from '@src/components/assets/execution-panel/AssetExecutionPanel';
import { FSRef } from '@sdk';
import { AgentToolbar, useAgentExecution } from './AgentToolbar';

interface AgentAssetEditorProps {
  /** FSRef to the agent .md file. */
  fsRef: FSRef;
}

/**
 * Agent asset editor with a Run toolbar button and streaming execution panel.
 *
 * - toolbar slot: AgentToolbar (Run/Stop button)
 * - execution panel: slides in when Run is clicked, shows streamed agent output
 */
export function AgentAssetEditor({ fsRef }: AgentAssetEditorProps) {
  const execution = useAgentExecution(fsRef.path);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <MarkdownEditor fsRef={fsRef} toolbar={<AgentToolbar execution={execution} />} />
      {execution.panelOpen && (
        <AssetExecutionPanel
          execution={execution}
          onClose={() => execution.setPanelOpen(false)}
        />
      )}
    </div>
  );
}
