/**
 * AgenticProcessMock - Mock Flow implementation for testing
 *
 * Extends Flow (which AgenticProcess inherits from via APIEntity's FlowData infrastructure).
 * ONLY overrides the API call methods (makeCancelAction/makeSendMessageAction).
 * All event/state handling is done natively by the Flow class.
 *
 * Provides AgenticProcess-compatible aliases:
 *   - executeInstruction() → sendMessage()
 *   - flowDataStream → stream
 *
 * Migration note: This replaces the old FlowMock class. The underlying implementation
 * extends Flow because tests rely on Flow's state management (options, chat_options,
 * stream, history). AgenticProcess-specific features can be added as the migration
 * of the test suite progresses.
 */

import { Flow, ICompletionOptions, IFlowState, TypeId } from '@sdk';
import { MOCK_FLOW_DELAY_MS, MOCK_STREAM_CHUNK_DELAY_MS } from '../../react/testConstants';
import { MockXMLStreamer, StreamBreakpointError } from '../../unit/mock_flow_streamer_test_utils';

// Define HistoryMessage type to match the one in Flow class
interface HistoryMessage {
  content: string;
  role: 'user' | 'assistant';
  timestamp: string;
}

export class AgenticProcessMock extends Flow {
  private _mockStreamXml: string;
  private _mockResumeXml: string | null = null;
  private processingDelay: number;
  public streamChunkDelay: number;
  private _currentStreamer: MockXMLStreamer | null = null;
  private _isStreamingActive: boolean = false;
  private _mockHistory: HistoryMessage[] = [];
  private _mockState: IFlowState | null = null;
  private _resumeCallback: (() => void) | null = null;

  constructor(entity: Partial<Flow> = {}) {
    // CRITICAL: Ensure entity has expand.auth_scopes with a project TypeId for FSStore integration.
    // The Flow class requires projectTypeId to enable chunk listeners for flow-write elements
    // (see flow.ts:592). Without it, appendContent is never called and FSStore remains empty.
    // Using a random project UUID for test isolation.
    const projectId = crypto.randomUUID();

    const entityWithScopes = {
      ...entity,
      expand: {
        ...entity.expand,
        auth_scopes: entity.expand?.auth_scopes || [[new TypeId('project', projectId).toString()]],
      },
    };
    super(entityWithScopes);
    this.markAsExpanded();

    // Use || delimiters to prevent random XML chunking which corrupts tags
    this._mockStreamXml = '<flow-mode>Agent</flow-mode>||<flow-checkpoint>Initial state</flow-checkpoint>';
    this.processingDelay = MOCK_FLOW_DELAY_MS;
    this.streamChunkDelay = MOCK_STREAM_CHUNK_DELAY_MS; // Set to 50ms for proper timing as requested
    this.enable_log();

    // Initialize expand.expansions to prevent API fetch in useEntity when marked as saved
    if (!this.expand) {
      this.expand = { expansions: [] };
    } else if (!this.expand.expansions) {
      this.expand.expansions = [];
    }
  }

  // ============ AgenticProcess-compatible API ============

  /**
   * AgenticProcess-compatible alias for sendMessage().
   * Allows tests to use the AgenticProcess API pattern.
   */
  async executeInstruction(instruction: string, _options: { sync?: boolean } = {}): Promise<void> {
    await this.sendMessage(instruction);
  }

  // ============ Flow API Overrides ============

  /**
   * Override ONLY the API call part of cancel - no events, no state handling
   */
  protected async callCancelAPI(): Promise<void> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, this.processingDelay));

    // No actual API call - just return successfully
    // Flow class will handle all events and state changes
  }

  /**
   * Override ONLY the API call part of resume - no events, no state handling
   */
  protected async callResumeAPI(): Promise<{ response: Response; abortController: AbortController } | null> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, this.processingDelay));

    // Create mock response stream using the _mockResumeXml
    if (!this._mockResumeXml) {
      return null;
    }
    const mockStream = this.createMockStream(this._mockResumeXml);
    const mockResponse = new Response(mockStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Transfer-Encoding': 'chunked',
      },
    });

    return { response: mockResponse, abortController: new AbortController() };
  }

  /**
   * Override save method to avoid network calls
   * Simulates successful save operation without making API calls
   */
  save(): Promise<Flow> {
    // Simulate save operation - no actual API call
    // In a real save, this would persist the entity to the backend
    this.log('save requested', undefined, '💾');

    // Mark as not dirty after successful save
    this._dirty = false;

    // Return resolved promise with this Flow instance
    return Promise.resolve(this);
  }

  /**
   * Override ONLY the API call part of sendMessage - no events, no state handling
   * This is where we simulate streaming the mockXml as the API response
   */
  protected async callSendMessageAPI(
    _message: string,
    _options?: ICompletionOptions,
  ): Promise<{ response: Response; abortController: AbortController }> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, this.processingDelay));
    this.log('creating mock stream');
    // Create mock response stream using the _mockXml from constructor
    // The _mockXml will be chunked by "||" delimiters and streamed
    const mockStream = this.createMockStream(this._mockStreamXml);
    this.log('mock stream created');

    const response = new Response(mockStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Transfer-Encoding': 'chunked',
      },
    });

    return { response, abortController: new AbortController() };
  }

  /**
   * Create a mock ReadableStream using MockXMLStreamer
   * This mimics the streaming behavior from the real API
   */
  private createMockStream(xml: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();

    // Always create a fresh streamer for each new sendMessage() call
    // This ensures each call processes the full XML stream from the beginning
    this._currentStreamer = new MockXMLStreamer(xml);

    const streamer = this._currentStreamer;

    // Capture the delay value in the outer scope to avoid 'this' context issues
    const chunkDelay = this.streamChunkDelay;

    this._isStreamingActive = true;

    return new ReadableStream({
      start: (controller) => {
        let _timeoutId: NodeJS.Timeout | null = null;

        const pushChunk = () => {
          try {
            const chunk = streamer.get_next_chunk();
            if (chunk !== null) {
              // this.log('pushing chunk', chunk);
              controller.enqueue(encoder.encode(chunk));
              // Use configurable streaming delay for tests (50ms for proper timing)
              _timeoutId = setTimeout(pushChunk, chunkDelay);
            } else {
              this._isStreamingActive = false;
              this._resumeCallback = null;
              controller.close();
            }
          } catch (error) {
            // Handle breakpoint exceptions
            if (error instanceof StreamBreakpointError) {
              console.log('🔴 AgenticProcessMock breakpoint:', error.message);
              this._isStreamingActive = false;
              this._resumeCallback = pushChunk; // Store callback for resume
              // Don't close controller - stream is paused, not ended
            } else {
              // Handle other errors
              this._isStreamingActive = false;
              this._resumeCallback = null;
              try {
                controller.error(error);
              } catch {
                // Controller may already be closed
              }
            }
          }
        };

        pushChunk();
      },
      cancel() {
        this._isStreamingActive = false;
        // Handle cancellation properly to avoid exceptions
        return Promise.resolve();
      },
    });
  }

  /**
   * Override fetchHistory to return the injected mock history.
   * This allows tests to inject mock history data without making API calls.
   *
   * @returns Promise<HistoryMessage[]> - The injected mock history
   */
  protected async fetchHistory(): Promise<HistoryMessage[]> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, this.processingDelay));

    // Return the injected mock history instead of calling the API
    return this._mockHistory;
  }

  /**
   * Override fetchState to return the injected mock state.
   * This allows tests to inject mock state data without making API calls.
   *
   * @returns Promise<IFlowState | null> - The injected mock state
   */
  protected async fetchState(): Promise<IFlowState | null> {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, this.processingDelay));

    // Return the injected mock state instead of calling the API
    return this._mockState;
  }

  setMockHistory(history: HistoryMessage[]): void {
    this._mockHistory = history;
    this.created_by = 'test'; // mark it saved, so loadHistory() will be called from useProcess
  }

  setMockState(state: IFlowState | null): void {
    this._mockState = state;
    this.created_by = 'test'; // mark it saved, so loadFlowState() will be called from useProcess
  }

  setMockResumeXML(xml_str: string): void {
    this._mockResumeXml = xml_str;
  }

  /**
   * Set mock XML content (does not trigger processing)
   * Call sendMessage() separately to start processing, just like normal flow behavior
   */
  setMockStreamXML(xml_str: string): void {
    // If this is the first call, set the XML directly
    if (!this._currentStreamer) {
      this._mockStreamXml = xml_str;
    } else {
      // If streamer exists but not active, append the XML
      if (!this._isStreamingActive) {
        this._mockStreamXml += xml_str;
      } else {
        // If currently streaming, queue the XML for next stream
        this._mockStreamXml = xml_str;
      }
    }
  }

  /**
   * Continue streaming from a breakpoint
   * Used by tests to resume after hitting |break| operator
   */
  async continueStreaming(): Promise<void> {
    if (this._currentStreamer && this._resumeCallback) {
      const currentCount = this.stream.items.length;

      this._currentStreamer.continue(); // Clear breakpoint flag
      this._isStreamingActive = true;

      // Clear _resumeCallback before calling it so we can detect when the NEXT breakpoint is hit
      const callback = this._resumeCallback;
      this._resumeCallback = null;

      callback(); // Resume streaming

      // Wait for stream items to increase or another breakpoint to be hit (max 200ms)
      const startTime = Date.now();
      const timeout = 200;

      while (Date.now() - startTime < timeout) {
        // Check if items increased or we hit another breakpoint
        // isAtBreakpoint() checks if _resumeCallback !== null, which will be set by the next BREAK
        if (this.stream.items.length > currentCount || this.isAtBreakpoint()) {
          return;
        }
        // Small delay before checking again
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Timeout - log warning but don't fail
      console.warn('⚠️  continueStreaming timeout: stream items did not increase within 200ms');
    } else {
      console.warn('⚠️  No active breakpoint to continue from');
    }
  }

  /**
   * Check if stream is paused at a breakpoint
   */
  isAtBreakpoint(): boolean {
    return this._resumeCallback !== null;
  }

  /**
   * Reset the mock streamer state (useful for test isolation)
   */
  resetStreamer(): void {
    this._currentStreamer = null;
    this._isStreamingActive = false;
    this._resumeCallback = null;
    this._mockStreamXml = '';
    this._mockHistory = [];
    this._mockState = null;
  }

  /**
   * Override clear to reset mock state as well
   */
  clear(): void {
    super.clear();
    // Reset mock-specific state
    this._currentStreamer = null;
    this._isStreamingActive = false;
    this._resumeCallback = null;
    this._mockHistory = [];
    this._mockState = null;
  }
}

/**
 * @deprecated Use AgenticProcessMock instead. Kept as alias during migration.
 */
export const FlowMock = AgenticProcessMock;
