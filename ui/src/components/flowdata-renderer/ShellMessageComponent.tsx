import { Trans } from '@lingui/react/macro';
import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';
import { useDataStreamText } from '@src/hooks/flow-hooks';

interface ShellMessageComponentProps {
  flowData: UIFlowData;
}

export function ShellMessageComponent({ flowData }: ShellMessageComponentProps) {
  const streamState = useDataStreamText(flowData);
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '⚡';

  return (
    <div className="shell-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role"><Trans>Shell Command</Trans></span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
        {streamState.isStreaming && <span className="streaming-indicator">●</span>}
      </div>
      <div className="message-content">
        <div className="shell-content">
          <div className="shell-command">
            <span className="shell-prompt">$</span>
            <span className="command-text">{flowData.displayContent}</span>
          </div>
          {streamState.isActive && (
            <div className="shell-output">
              <pre>{streamState.partialContent}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
