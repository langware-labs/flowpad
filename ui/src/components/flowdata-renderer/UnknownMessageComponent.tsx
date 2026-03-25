import { UIFlowData } from '@src/types/ui-flowdata';

interface UnknownMessageComponentProps {
  flowData: UIFlowData;
}

export function UnknownMessageComponent({ flowData }: UnknownMessageComponentProps) {
  return (
    <div className="unknown-message">
      <div className="message-header">
        <span className="message-icon">❓</span>
        <span className="message-role">Unknown ({flowData.elementType})</span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
      </div>
      <div className="message-content">
        <div className="unknown-content">
          <div className="debug-info">
            <div>
              <strong>Element Type:</strong> {flowData.elementType}
            </div>
            <div>
              <strong>Data:</strong> {JSON.stringify(flowData.data, null, 2)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
