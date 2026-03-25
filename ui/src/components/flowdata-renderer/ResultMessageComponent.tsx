import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';

interface ResultMessageComponentProps {
  flowData: UIFlowData;
}

export function ResultMessageComponent({ flowData }: ResultMessageComponentProps) {
  const result = flowData.data as { path?: string };
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '📄';

  return (
    <div className="result-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role">File Result</span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
      </div>
      <div className="message-content">
        <div className="result-content">
          <div className="file-info">
            <span className="file-path">{result.path || flowData.displayContent}</span>
          </div>
          <div className="result-actions">
            <button
              className="copy-button"
              onClick={() => {
                void navigator.clipboard?.writeText(result.path || '');
              }}
            >
              Copy Path
            </button>
            <button className="view-button">View File</button>
          </div>
        </div>
      </div>
    </div>
  );
}
