import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';

interface WriteMessageComponentProps {
  flowData: UIFlowData;
}

export function WriteMessageComponent({ flowData }: WriteMessageComponentProps) {
  const writeData = flowData.data as { path?: string; content?: string };
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '✏️';

  return (
    <div className="write-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role">File Write</span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
      </div>
      <div className="message-content">
        <div className="write-content">
          <div className="file-path">{writeData.path || flowData.displayContent}</div>
          <div className="write-actions">
            <button className="view-file-button">View File</button>
            <button className="copy-path-button">Copy Path</button>
          </div>
        </div>
      </div>
    </div>
  );
}
