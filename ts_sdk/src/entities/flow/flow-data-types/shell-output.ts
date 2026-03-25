import { JsonFlowData } from './primitives';
import { FlowDataAttribute } from '../../../flow_processing/flow-data';
import { FlowElementTypes } from '../../../flow_processing/flow-element-types';

/**
 * Shell result data structure for shell-output FlowData elements
 * Replaces the legacy ICommandResult interface
 */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

/**
 * Specialized FlowData for shell command output
 * Replaces the legacy ICommandResult and ShellCommand.result
 */
export class ShellOutputFlowData extends JsonFlowData<ShellResult> {
  constructor(stdout: string = '', stderr: string = '', exitCode?: number) {
    const data: ShellResult = {
      stdout,
      stderr,
      exitCode,
    };

    const attributes: Record<string, string> = {
      [FlowDataAttribute.INDEX]: '0',
      [FlowDataAttribute.ELEMENT_TYPE]: FlowElementTypes.SHELL_OUTPUT,
      [FlowDataAttribute.TIMESTAMP]: new Date().toISOString(),
    };

    if (exitCode !== undefined) {
      attributes[FlowDataAttribute.EXIT_CODE] = exitCode.toString();
    }

    super(FlowElementTypes.SHELL_OUTPUT, data, attributes);
  }

  /**
   * Partial ID from server response (used by StreamProcessor for merging)
   * Client should not set this - only read from server responses
   */
  get partialId(): string {
    return this.attributes[FlowDataAttribute.PARTIAL_ID] || '';
  }

  /**
   * Standard output content
   */
  get stdout(): string {
    return this.data.stdout;
  }

  /**
   * Standard error content
   */
  get stderr(): string {
    return this.data.stderr;
  }

  /**
   * Alias for exit_code (camelCase)
   */
  get exitCode(): number | undefined {
    return this.data.exitCode;
  }

  /**
   * Whether the command has completed
   */
  get isComplete(): boolean {
    return this.data.exitCode !== undefined;
  }

  /**
   * Append stdout content (for streaming)
   */
  appendStdout(content: string): void {
    this.data.stdout += content;
  }

  /**
   * Append stderr content (for streaming)
   */
  appendStderr(content: string): void {
    this.data.stderr += content;
  }

  /**
   * Mark command as complete with exit code
   */
  markComplete(exitCode: number): void {
    this.data.exitCode = exitCode;
    this.attributes[FlowDataAttribute.EXIT_CODE] = exitCode.toString();
  }

  /**
   * Create from backend response data
   */
  static fromResponse(data: { exit_code: number; stdout: string; stderr: string }): ShellOutputFlowData {
    return new ShellOutputFlowData(data.stdout, data.stderr, data.exit_code);
  }
}
