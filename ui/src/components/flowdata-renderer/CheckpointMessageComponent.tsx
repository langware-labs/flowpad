import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';

interface CheckpointMessageComponentProps {
  flowData: UIFlowData;
}

export function CheckpointMessageComponent({ flowData }: CheckpointMessageComponentProps) {
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '📍';
  return (
    <div className="checkpoint-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role">Checkpoint</span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
      </div>
      <div className="message-content">
        <div className="checkpoint-content">
          <div className="checkpoint-info">{flowData.displayContent}</div>
        </div>
      </div>
    </div>
  );
}
