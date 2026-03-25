import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';
import { UserMessageType } from '@sdk';

interface UserMessageComponentProps {
  flowData: UIFlowData;
}

export function UserMessageComponent({ flowData }: UserMessageComponentProps) {
  const messageType = (flowData.attributes['message-type'] as UserMessageType) || UserMessageType.TEXT;
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '👤';

  const renderContent = () => {
    if (messageType === UserMessageType.SURVEY_RESULT) {
      // Display survey results as formatted JSON
      return (
        <div className="user-message-survey-result">
          <div className="mb-2 text-sm font-semibold">📋 Survey Response</div>
          <pre className="overflow-auto rounded bg-muted p-3 text-xs">{flowData.displayContent}</pre>
        </div>
      );
    }

    // Regular text message
    return <div className="user-input-text">{flowData.displayContent}</div>;
  };

  return (
    <div className="user-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role">You</span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
      </div>
      <div className="message-content">{renderContent()}</div>
    </div>
  );
}
