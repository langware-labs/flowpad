import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';
import { useDataStreamText } from '@src/hooks/flow-hooks';

interface TextMessageComponentProps {
  flowData: UIFlowData;
}

export function TextMessageComponent({ flowData }: TextMessageComponentProps) {
  const streamState = useDataStreamText(flowData);
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '💬';

  return (
    <div className="text-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role">Assistant</span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
        {streamState.isStreaming && <span className="streaming-indicator">●</span>}
      </div>
      <div className="message-content">
        <div className="text-content">
          {streamState.isStreaming ? streamState.partialContent : flowData.displayContent}
        </div>
        {streamState.isStreaming && (
          <div className="streaming-progress">
            <div className="progress-bar" style={{ width: `${streamState.progressPercent}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
