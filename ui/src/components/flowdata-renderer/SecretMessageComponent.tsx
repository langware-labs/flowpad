import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';

interface SecretMessageComponentProps {
  flowData: UIFlowData;
}

export function SecretMessageComponent({ flowData }: SecretMessageComponentProps) {
  const secretData = flowData.data as { name?: string; description?: string };
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '🔐';

  return (
    <div className="secret-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role">Secret Required</span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
      </div>
      <div className="message-content">
        <div className="secret-content">
          <div className="secret-info">
            <div className="secret-name">{secretData.name || 'Secret'}</div>
            {secretData.description && <div className="secret-description">{secretData.description}</div>}
          </div>
          <div className="secret-actions">
            <button className="provide-secret-button">Provide Secret</button>
          </div>
        </div>
      </div>
    </div>
  );
}
