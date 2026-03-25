import { useState } from 'react';
import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';

interface ReasoningMessageComponentProps {
  flowData: UIFlowData;
}

export function ReasoningMessageComponent({ flowData }: ReasoningMessageComponentProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '🤔';

  return (
    <div className="reasoning-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role">Assistant Reasoning</span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
        <button
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-label={isExpanded ? 'Collapse reasoning' : 'Expand reasoning'}
        >
          {isExpanded ? '▼' : '▶'}
        </button>
      </div>
      {isExpanded && (
        <div className="message-content">
          <div className="reasoning-content">
            <pre>{flowData.displayContent}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
