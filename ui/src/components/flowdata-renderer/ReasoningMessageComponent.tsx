import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Trans } from '@lingui/react/macro';
import { EnhancedFlowData } from '@src/types/ui-flowdata';
import { UIFlowData } from '@src/types/ui-flowdata';

interface ReasoningMessageComponentProps {
  flowData: UIFlowData;
}

export function ReasoningMessageComponent({ flowData }: ReasoningMessageComponentProps) {
  const { t } = useLingui();
  const [isExpanded, setIsExpanded] = useState(false);
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '🤔';

  return (
    <div className="reasoning-message">
      <div className="message-header">
        <span className="message-icon">{icon}</span>
        <span className="message-role"><Trans>Assistant Reasoning</Trans></span>
        <span className="message-timestamp">{flowData.displayTimestamp}</span>
        <button
          className="expand-button"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-label={isExpanded ? t`Collapse reasoning` : t`Expand reasoning`}
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
