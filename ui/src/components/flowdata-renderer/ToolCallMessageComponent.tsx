import { EnhancedFlowData, UIFlowData } from '@src/types/ui-flowdata';

interface ToolCallMessageComponentProps {
  flowData: UIFlowData;
}

/**
 * Renders a tool call message showing which tool Claude is using.
 * Used to display status during plan execution (e.g., "Reading file...", "Writing code...")
 */
export function ToolCallMessageComponent({ flowData }: ToolCallMessageComponentProps) {
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '🔧';

  // Extract tool name from attributes or data
  const toolName = flowData.attributes['tool-name'] || 'Tool';

  // Get a friendly description based on tool name
  const getToolDescription = (name: string): string => {
    const toolDescriptions: Record<string, string> = {
      Read: 'Reading file',
      Write: 'Writing file',
      Edit: 'Editing file',
      Bash: 'Running command',
      Grep: 'Searching code',
      Glob: 'Finding files',
      Task: 'Running task',
      WebFetch: 'Fetching URL',
      WebSearch: 'Searching web',
    };
    return toolDescriptions[name] || `Using ${name}`;
  };

  const description = getToolDescription(toolName);

  // Extract input summary (file path or command)
  const getInputSummary = (): string => {
    const data = flowData.data as Record<string, unknown>;
    if (typeof data !== 'object' || !data) return '';

    const input = data.input as Record<string, unknown>;
    if (!input) return '';

    // Common input fields to display - only use string values
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.command === 'string') return input.command.substring(0, 50);
    if (typeof input.pattern === 'string') return `"${input.pattern}"`;
    if (typeof input.url === 'string') return input.url;
    if (typeof input.query === 'string') return `"${input.query}"`;

    return '';
  };

  const inputSummary = getInputSummary();

  return (
    <div className="tool-call-message">
      <span className="message-icon">{icon}</span>
      <span className="message-role">{description}</span>
      {inputSummary && <span className="tool-input-summary">{inputSummary}</span>}
    </div>
  );
}
