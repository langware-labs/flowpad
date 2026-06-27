import { EnhancedFlowData, UIFlowData } from '@src/types/ui-flowdata';

interface ToolCallMessageComponentProps {
  flowData: UIFlowData;
}

/**
 * One-liner summary of a tool's input. Reads `data.input` (or `data.args` for
 * Claude-style TOOL_CALL payloads) and pulls the first known string field.
 * Order mirrors the legacy renderer: file_path > command > pattern > url > query.
 *
 * Exported so the dense floating-chat row can reuse the same precedence.
 */
export function describeToolInput(data: unknown): string {
  if (typeof data !== 'object' || !data) return '';
  const root = data as Record<string, unknown>;
  const input = (root.input ?? root.args) as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') return '';
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.command === 'string') return input.command.substring(0, 80);
  if (typeof input.pattern === 'string') return `"${input.pattern}"`;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.query === 'string') return `"${input.query}"`;
  return '';
}

const FRIENDLY_TOOL_DESCRIPTIONS: Record<string, string> = {
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Bash: 'Running command',
  Grep: 'Searching code',
  Glob: 'Finding files',
  Task: 'Running task',
  WebFetch: 'Fetching URL',
  WebSearch: 'Searching web',
  ExitPlanMode: 'Plan ready',
  AskUserQuestion: 'Asking a question',
};

export function describeToolName(toolName: string): string {
  return FRIENDLY_TOOL_DESCRIPTIONS[toolName] || `Using ${toolName}`;
}

/**
 * Renders a tool call message showing which tool Claude is using.
 * Used to display status during plan execution (e.g., "Reading file...", "Writing code...")
 */
export function ToolCallMessageComponent({ flowData }: ToolCallMessageComponentProps) {
  const icon = flowData instanceof EnhancedFlowData ? flowData.getIcon() : '🔧';
  const toolName = flowData.attributes['tool-name'] || 'Tool';
  const description = describeToolName(toolName);
  const inputSummary = describeToolInput(flowData.data);

  return (
    <div className="tool-call-message">
      <span className="message-icon">{icon}</span>
      <span className="message-role">{description}</span>
      {inputSummary && <span className="tool-input-summary">{inputSummary}</span>}
    </div>
  );
}
