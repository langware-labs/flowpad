import { FlowData, FlowElementTypes } from '@sdk';

/**
 * Enhanced FlowData with UI-specific computed properties
 * Extends FlowData with display-friendly interfaces
 */
export interface UIFlowData extends FlowData {
  // UI-specific computed properties
  readonly displayRole: 'user' | 'assistant';
  readonly displayTimestamp: string;
  readonly isUser: boolean;
  readonly isAssistant: boolean;
  readonly componentType: string;
  readonly displayContent: string;
  readonly hasActions: boolean;
  readonly isStreaming: boolean;
  readonly canCopy: boolean;
  readonly canEdit: boolean;
  readonly messageSource: 'history' | 'stream' | 'user-input';
}

/**
 * Enhanced FlowData implementation with UI-friendly methods
 */
export class EnhancedFlowData extends FlowData implements UIFlowData {
  get displayRole(): 'user' | 'assistant' {
    return (this.attributes.role as 'user' | 'assistant') || 'assistant';
  }

  get displayTimestamp(): string {
    const timestamp = this.attributes.timestamp;
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString();
  }

  get isUser(): boolean {
    return this.elementType === FlowElementTypes.USER_MESSAGE || this.displayRole === 'user';
  }

  get isAssistant(): boolean {
    return !this.isUser;
  }

  get componentType(): string {
    // Map elementType to React component type
    const componentMap: Record<string, string> = {
      [FlowElementTypes.USER_MESSAGE]: 'UserMessage',
      [FlowElementTypes.TEXT]: 'TextMessage',
      [FlowElementTypes.CHAT]: 'TextMessage',
      [FlowElementTypes.REASONING]: 'ReasoningMessage',
      [FlowElementTypes.SHELL]: 'ShellMessage',
      [FlowElementTypes.SHELL_INPUT]: 'ShellMessage',
      [FlowElementTypes.SHELL_OUTPUT]: 'ShellMessage',
      [FlowElementTypes.RESULT]: 'ResultMessage',
      [FlowElementTypes.ENV_VAR]: 'SecretMessage',
      [FlowElementTypes.CHECKPOINT]: 'CheckpointMessage',
      [FlowElementTypes.STATUS]: 'StatusMessage',
      [FlowElementTypes.WRITE]: 'WriteMessage',
      [FlowElementTypes.TOOL_CALL]: 'ToolCallMessage',
      [FlowElementTypes.TOOL_RESULT]: 'ToolResultMessage',
      [FlowElementTypes.ERROR]: 'ErrorMessage',
    };
    return componentMap[this.elementType] || 'UnknownMessage';
  }

  get displayContent(): string {
    // Clean content for display
    if (this.elementType === FlowElementTypes.USER_MESSAGE) return this.data as string;
    if (this.elementType === FlowElementTypes.TEXT) return this.data as string;
    if (typeof this.data === 'string') return this.data;
    return this.content || JSON.stringify(this.data);
  }

  get hasActions(): boolean {
    return (
      this.elementType === FlowElementTypes.RESULT ||
      this.elementType === FlowElementTypes.SHELL ||
      this.elementType === FlowElementTypes.ENV_VAR ||
      this.elementType === FlowElementTypes.WRITE
    );
  }

  get isStreaming(): boolean {
    return !this.ready && this.attributes.source === 'stream';
  }

  get canCopy(): boolean {
    return (
      this.elementType === FlowElementTypes.TEXT ||
      this.elementType === FlowElementTypes.USER_MESSAGE ||
      this.elementType === FlowElementTypes.SHELL ||
      this.elementType === FlowElementTypes.RESULT
    );
  }

  get canEdit(): boolean {
    return this.elementType === FlowElementTypes.USER_MESSAGE;
  }

  get messageSource(): 'history' | 'stream' | 'user-input' {
    return (this.attributes.source as 'history' | 'stream' | 'user-input') || 'stream';
  }

  /**
   * Get formatted content based on message type
   */
  getFormattedContent(): string {
    switch (this.elementType) {
      case FlowElementTypes.SHELL:
        return `$ ${this.displayContent}`;
      case FlowElementTypes.RESULT:
        return `📄 ${this.displayContent}`;
      case FlowElementTypes.REASONING:
        return `🤔 ${this.displayContent}`;
      case FlowElementTypes.STATUS:
        return `⚡ ${this.displayContent}`;
      default:
        return this.displayContent;
    }
  }

  /**
   * Get icon for message type
   */
  getIcon(): string {
    const iconMap: Record<string, string> = {
      [FlowElementTypes.USER_MESSAGE]: '👤',
      [FlowElementTypes.TEXT]: '💬',
      [FlowElementTypes.REASONING]: '🤔',
      [FlowElementTypes.SHELL]: '⚡',
      [FlowElementTypes.RESULT]: '📄',
      [FlowElementTypes.ENV_VAR]: '🔐',
      [FlowElementTypes.CHECKPOINT]: '📍',
      [FlowElementTypes.STATUS]: '⚡',
      [FlowElementTypes.WRITE]: '✏️',
      [FlowElementTypes.TOOL_CALL]: '🔧',
      [FlowElementTypes.TOOL_RESULT]: '📋',
    };
    return iconMap[this.elementType] || '💬';
  }
}

/**
 * Convert regular FlowData to enhanced UI FlowData
 */
export function enhanceFlowData(flowData: FlowData): UIFlowData {
  // If it's already enhanced, return as-is
  if (flowData instanceof EnhancedFlowData) {
    return flowData;
  }

  // Create new enhanced instance
  const enhanced = new EnhancedFlowData(flowData.fullTagName, flowData.data, flowData.attributes);

  // Copy any additional properties
  Object.assign(enhanced, flowData);

  return enhanced;
}

/**
 * Convert FlowData array to enhanced UI FlowData array
 */
export function enhanceFlowDataArray(flowDataArray: FlowData[]): UIFlowData[] {
  return flowDataArray.map(enhanceFlowData);
}
