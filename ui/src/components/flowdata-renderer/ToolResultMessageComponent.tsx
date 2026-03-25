import { EnhancedFlowData, UIFlowData } from '@src/types/ui-flowdata';

interface ToolResultMessageComponentProps {
  flowData: UIFlowData;
}

/**
 * Renders a tool result message showing the outcome of a tool call.
 * Shows success/error status and a summary of the result.
 */
export function ToolResultMessageComponent({ flowData }: ToolResultMessageComponentProps) {
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '📋';
  const isError = flowData.attributes['is-error'] === 'true' || flowData.attributes['is-error'] === 'True';

  // Truncate long results
  const content = flowData.displayContent;
  const truncatedContent = content.length > 200 ? content.substring(0, 200) + '...' : content;

  return (
    <div className={`tool-result-message ${isError ? 'error' : 'success'}`}>
      <span className="message-icon">{isError ? '❌' : icon}</span>
      <span className="tool-result-text">{truncatedContent}</span>
    </div>
  );
}
