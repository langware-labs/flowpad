import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';

interface StatusMessageComponentProps {
  flowData: UIFlowData;
}

export function StatusMessageComponent({ flowData }: StatusMessageComponentProps) {
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '⚡';

  return (
    <div className="status-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role">Status</span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
      </div>
      <div className="message-content">
        <div className="status-content">
          <div className="status-text">{flowData.displayContent}</div>
        </div>
      </div>
    </div>
  );
}
