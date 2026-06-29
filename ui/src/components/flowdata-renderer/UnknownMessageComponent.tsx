import { Trans } from '@lingui/react/macro';
import { UIFlowData } from '@src/types/ui-flowdata';

interface UnknownMessageComponentProps {
  flowData: UIFlowData;
}

export function UnknownMessageComponent({ flowData }: UnknownMessageComponentProps) {
  return (
    <div className="unknown-message">
      <div className="message-header">
        <span className="message-icon">❓</span>
        <span className="message-role">
          <Trans>Unknown ({flowData.elementType})</Trans>
        </span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
      </div>
      <div className="message-content">
        <div className="unknown-content">
          <div className="debug-info">
            <div>
              <Trans>
                <strong>Element Type:</strong> {flowData.elementType}
              </Trans>
            </div>
            <div>
              <Trans>
                <strong>Data:</strong> {JSON.stringify(flowData.data, null, 2)}
              </Trans>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
