import { TextFlowData } from './primitives';
import { FlowDataAttribute } from '../flow-data';
import { FlowElementTypes } from '../flow-element-types';

/**
 * Shell command data structure for shell-input FlowData elements
 */
export interface ShellCmd {
  command: string;
  sessionId: string;
  timestamp: number;
}

/**
 * Specialized FlowData for shell command input
 * Replaces the legacy ShellCommand class
 */
export class ShellCmdFlowData extends TextFlowData<{ content: string }> {
  private readonly _id: string;
  private readonly _command: string;
  private readonly _sessionId: string;
  private readonly _timestamp: number;
  public isRunning: boolean = false;

  constructor(command: string, sessionId: string = 'flowShell', timestamp?: number) {
    const commandTimestamp = timestamp ?? Date.now();

    // Pass just the command string to TextFlowData (must call super() first)
    super(FlowElementTypes.SHELL_INPUT, command, {
      [FlowDataAttribute.INDEX]: '0',
      [FlowDataAttribute.ELEMENT_TYPE]: FlowElementTypes.SHELL_INPUT,
      [FlowDataAttribute.SESSION_ID]: sessionId,
      [FlowDataAttribute.TIMESTAMP]: new Date(commandTimestamp).toISOString(),
    });

    // Store command, sessionId, and timestamp as private fields
    this._command = command;
    this._sessionId = sessionId;
    this._timestamp = commandTimestamp;

    // Generate unique 10-character base64 id based on timestamp
    this._id = this.generateId(commandTimestamp);
  }

  /**
   * Generate a deterministic 10-character base64 id
   * Uses timestamp + sessionId + command to ensure:
   * 1. Same historical command always gets same ID (deterministic)
   * 2. Different commands get different IDs (uniqueness)
   */
  private generateId(timestamp: number): string {
    // Use timestamp + sessionId + command for deterministic ID generation
    // This ensures the same historical command always produces the same ID
    const combined = `${timestamp}-${this._sessionId}-${this._command}`;

    // Simple hash function to create a deterministic numeric value
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    // Use absolute value and convert to base36 for compact representation
    const hashStr = Math.abs(hash).toString(36);

    // Pad or truncate to 10 characters
    return (hashStr + timestamp.toString(36)).substring(0, 10).padStart(10, '0');
  }

  /**
   * Unique identifier for this command
   * Auto-generated 10-character base64 string
   */
  get id(): string {
    return this._id;
  }

  /**
   * Partial ID from server response (used by StreamProcessor for merging)
   * Client should not set this - only read from server responses
   */
  get partialId(): string {
    return this.attributes[FlowDataAttribute.PARTIAL_ID] || '';
  }

  /**
   * The command string to execute
   */
  get command(): string {
    return this._command;
  }

  /**
   * Content getter override to return command text
   * This provides a unified interface for accessing text content
   */
  get content(): string {
    return this._command;
  }

  /**
   * Shell session ID
   */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Command submission timestamp
   */
  get commandTimestamp(): number {
    return this._timestamp;
  }
}
