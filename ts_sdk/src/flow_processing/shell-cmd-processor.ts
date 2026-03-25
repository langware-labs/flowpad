import { FlowData } from './flow-data';
import { FlowDataChunk, FlowDataEvents, FlowEvents } from './flow-events';
import { FlowElementTypes } from './flow-element-types';
import { FlowStreamProcessor } from './flow-stream-processor';

/**
 * Progress information for shell command execution
 * Reports the actual FlowData elements as they arrive from the stream processor
 */
export interface ShellCmdProgress {
  stdoutElement: FlowData | null; // The actual stdout FlowData element
  stderrElement: FlowData | null; // The actual stderr FlowData element
  exitCodeElement: FlowData | null; // The actual exit code FlowData element (final element)
  stdoutDelta: string; // New stdout since last update
  stderrDelta: string; // New stderr since last update
  exitCode: number | null; // Exit code (null until final element)
}

/**
 * Processor for shell command streaming responses
 * Handles progressive XML parsing and builds a complete FlowDataStream
 */
export class ShellCommandProcessor {
  /**
   * Process a shell command stream from a ReadableStream
   *
   * @param reader - ReadableStreamDefaultReader providing chunked XML response
   * @param onCmdProgress - Optional callback invoked for streaming updates with FlowData elements
   * @param abortController - Optional AbortController for cancellation
   *
   * @example
   * ```typescript
   * const response = await fetch('/api/command', { method: 'POST' });
   * const reader = response.body.getReader();
   *
   * await ShellCommandProcessor.processCmdStream(
   *   reader,
   *   (progress) => {
   *     console.log('Progress stdout:', progress.stdoutElement?.content);
   *     console.log('Progress delta:', progress.stdoutDelta);
   *   }
   * );
   * ```
   */
  static async processCmdStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onCmdProgress?: (progress: ShellCmdProgress) => void,
    abortController?: AbortController,
  ): Promise<void> {
    const processor = new FlowStreamProcessor();

    // Track the single FlowData element per channel
    let stdoutElement: FlowData | null = null;
    let stderrElement: FlowData | null = null;
    let exitCodeElement: FlowData | null = null;

    // Track event listeners for cleanup
    const unsubscribers: Array<() => void> = [];

    // Track deltas for progress reporting
    let stdoutPrevLength = 0;
    let stderrPrevLength = 0;
    let exitCode: number | null = null;

    const emitProgress = () => {
      if (onCmdProgress) {
        const stdoutDelta = stdoutElement ? stdoutElement.content.slice(stdoutPrevLength) : '';
        const stderrDelta = stderrElement ? stderrElement.content.slice(stderrPrevLength) : '';

        onCmdProgress({
          stdoutElement,
          stderrElement,
          exitCodeElement,
          stdoutDelta,
          stderrDelta,
          exitCode,
        });

        if (stdoutElement) stdoutPrevLength = stdoutElement.content.length;
        if (stderrElement) stderrPrevLength = stderrElement.content.length;
      }
    };

    // Listen for channel elements (stdout/stderr)
    processor.on(FlowEvents.STREAM_ELEMENT_START, (flowData: FlowData) => {
      if (flowData.elementType === FlowElementTypes.SHELL_OUTPUT) {
        const channel = flowData.channel;

        if (channel === 'stdout') {
          stdoutElement = flowData;

          // Listen to chunks on this element and emit progress
          const unsubscribe = flowData.on(FlowDataEvents.CHUNK, (_chunk: FlowDataChunk) => {
            emitProgress();
          });

          if (typeof unsubscribe === 'function') {
            unsubscribers.push(unsubscribe);
          }
        } else if (channel === 'stderr') {
          stderrElement = flowData;

          // Listen to chunks on this element and emit progress
          const unsubscribe = flowData.on(FlowDataEvents.CHUNK, (_chunk: FlowDataChunk) => {
            emitProgress();
          });

          if (typeof unsubscribe === 'function') {
            unsubscribers.push(unsubscribe);
          }
        }
      }
    });

    // Handle completed elements
    processor.on(FlowEvents.STREAM_ELEMENT_END, (flowData: FlowData) => {
      if (flowData.elementType === FlowElementTypes.SHELL_OUTPUT) {
        const channel = flowData.channel;

        if (!channel && flowData.isFinal) {
          // Final element with exit code
          exitCodeElement = flowData;

          if (flowData.hasAttribute('exit-code')) {
            exitCode = parseInt(flowData.attributes['exit-code'], 10);
            // Emit final progress with exit code
            emitProgress();
          }
        }
      }
    });

    // Process the stream
    await processor.ingestStream(reader, abortController);

    // Cleanup event listeners
    unsubscribers.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (cleanupError) {
        console.warn('[ShellCommandProcessor] Error cleaning up event listener:', cleanupError);
      }
    });

    // Validate that we got output
    if (!stdoutElement && !stderrElement && !exitCodeElement) {
      throw new Error('No output received from command');
    }
  }
}
