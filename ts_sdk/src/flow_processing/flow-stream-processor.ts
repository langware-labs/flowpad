import { EventEmitter } from 'events';
import { FlowDataFactory } from './flow-data-factory';
import { FlowData, FlowDataSource, FlowDataType } from './flow-data';
import { FlowError, FlowErrorEvent, FlowErrorUtils } from './flow-errors';
import { FlowDataEvents, FlowEvents } from './flow-events';
import { GroupChannelKey } from './group-channel-key';
import { parseAttributes, waitForChunks } from './xml-utilities';

/**
 * Processing states for the XML stream processor
 */
enum ProcessorState {
  WaitingForStart, // Looking for start tag
  ProcessingContent, // Processing content between tags
  WaitingForEnd, // Looking for end tag
}

/**
 * FlowStreamProcessor - Simple string-based streaming XML processor
 * This class handles streaming XML parsing and event emission with aggregation support
 */
export class FlowStreamProcessor extends EventEmitter {
  private queueStr!: string;
  private state!: ProcessorState;
  private currentElement!: FlowData | null;
  private isStreaming!: boolean;

  // Aggregation support
  private aggregatedText!: string;
  private aggregatedEvents!: FlowData[];

  // Group-Channel FlowData tracking
  private trackedGroups!: Map<string, FlowData>; // Key: GroupChannelKey.toString()
  private groupChannels!: Map<string, Set<string>>; // groupId → Set<channel>
  private readonly MAX_GROUPS = 20;
  private readonly ONCE_ATTRS = ['t', 'i'];
  private pendingElement!: FlowData | null; // Stores the new element being processed

  constructor() {
    super();
    this.reset();
    this.emit(FlowEvents.LOG, '🔹 XMLProcessor: initialized');
  }

  /**
   * Get the current element under processing
   */
  get elementUnderProcessing(): FlowData | null {
    return this.currentElement;
  }

  private registerElementLogging(element: FlowData): void {
    // Forward verbose log events from FlowData to processor as log:verbose
    element.on(FlowDataEvents.LOG_VERBOSE, (message: string) => {
      this.emit(FlowEvents.LOG_VERBOSE, message);
    });
    // Forward standard log events from FlowData (if any)
    element.on(FlowDataEvents.LOG, (message: string) => {
      this.emit(FlowEvents.LOG_VERBOSE, message);
    });
    // Forward error events from FlowData to processor
    element.on(FlowDataEvents.ERROR, (errorEvent: FlowErrorEvent) => {
      this.emit(FlowEvents.ERROR, errorEvent);
    });
  }

  /**
   * Process a chunk of XML data using simple string-based state machine
   * Handles partial tags and emits events when complete tags are found
   */
  process_chunk(chunk: string): void {
    if (!this.isStreaming) {
      this.emit(FlowEvents.STREAM_START);
      this.isStreaming = true;
    }
    // Add chunk to queue string and aggregated text
    this.queueStr += chunk;
    this.aggregatedText += chunk;

    // Process everything in the queue using state machine
    this.processQueue();
  }

  async ingestStream(
    stream: ReadableStreamDefaultReader<Uint8Array>,
    abortController?: AbortController,
  ): Promise<void> {
    const decoder = new TextDecoder();

    const processStream = async (): Promise<void> => {
      try {
        // Check if the request was aborted
        if (abortController?.signal.aborted) {
          this.endStream();
          this.emit(FlowEvents.STREAM_CANCEL);
          return;
        }

        const { done, value } = await stream.read();

        // Check if the request was aborted after read
        if (abortController?.signal.aborted) {
          this.endStream();
          this.emit(FlowEvents.STREAM_CANCEL);
          return;
        }
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          this.process_chunk(chunk);
        }
        if (done) {
          this.endStream();
          return;
        }
        // Continue processing the stream
        return processStream();
      } catch (streamError: any) {
        if (streamError.name && streamError.name === 'AbortError') {
          this.abortStream();
          return;
        }
        console.error('Error processing stream:', streamError);
        throw streamError;
      }
    };

    await processStream();
  }

  /**
   * Process the queue using simple state machine approach
   */
  private processQueue(): void {
    let continueProcessing = true;

    while (continueProcessing) {
      continueProcessing = false; // Reset flag, set to true if we make progress

      switch (this.state) {
        case ProcessorState.WaitingForStart:
          continueProcessing = this.handleWaitingForStart();
          break;

        case ProcessorState.ProcessingContent:
          continueProcessing = this.handleProcessingContent();
          break;

        case ProcessorState.WaitingForEnd:
          continueProcessing = this.handleWaitingForEnd();
          break;
      }
    }
  }

  /**
   * Handle waiting for start tag state
   */
  private handleWaitingForStart(): boolean {
    // Wait for either regular start tag "<...>" or self-closing tag "<.../>"
    if (waitForChunks(this.queueStr, ['<', '>'])) {
      const startIndex = this.queueStr.indexOf('<');
      const endIndex = this.queueStr.indexOf('>', startIndex);

      // Extract the full tag including < and >
      const fullTag = this.queueStr.substring(startIndex, endIndex + 1);
      const tagContent = fullTag.substring(1, fullTag.length - 1); // Remove < and >

      // Check for self-closing tag
      if (tagContent.endsWith('/')) {
        // Self-closing tag - create and complete immediately
        const cleanTag = tagContent.slice(0, -1).trim();
        this.createElementFromStartTag(cleanTag);
        if (!this.currentElement) {
          console.warn('⚠️ [handleWaitingForStart] No current element');
          return false; // Wait for more chunks
        }
        this.currentElement.isSelfClosing = true;
        this.handleElementCompletion(this.currentElement);
        this.currentElement = null; // Reset current element

        // Remove processed content from queue
        this.queueStr = this.queueStr.substring(endIndex + 1);
        // Stay in WaitingForStart state for next element
        return true; // Continue processing
      }

      // Regular start tag - create element
      this.createElementFromStartTag(tagContent);

      // Remove processed content from queue
      this.queueStr = this.queueStr.substring(endIndex + 1);

      // Move to content processing state
      this.state = ProcessorState.ProcessingContent;
      return true; // Continue processing
    }

    return false; // Not ready to process, wait for more chunks
  }

  /**
   * Handle processing content state
   */
  private handleProcessingContent(): boolean {
    if (!this.currentElement) {
      console.warn('⚠️ [handleProcessingContent] No current element');
      return false; // Should not happen, but safety check
    }

    // Get the expected end tag for the current element
    const expectedEndTag = `</${this.currentElement.fullTagName}>`;

    // Check if content contains the specific end tag
    const endTagStart = this.queueStr.indexOf(expectedEndTag);

    if (endTagStart === -1) {
      // Specific end tag not found yet
      // Check if we have a potential start of the end tag at the end of queue
      const potentialEndStart = this.findPotentialEndTagStart(expectedEndTag);

      if (potentialEndStart >= 0) {
        // Send content before the potential end tag start to current element
        if (potentialEndStart > 0) {
          const contentToSend = this.queueStr.substring(0, potentialEndStart);
          if (contentToSend.length > 0) {
            this.currentElement.parseChunk(contentToSend);
          }
          // Keep only the potential end tag part in queue
          this.queueStr = this.queueStr.substring(potentialEndStart);
        }
        return false; // Wait for more chunks
      } else {
        // No potential end tag found, send all content to current element
        if (this.queueStr.length > 0) {
          this.currentElement.parseChunk(this.queueStr);
          this.queueStr = ''; // Clear queue after sending to element
        }
        return false; // Wait for more chunks
      }
    }

    // Found the specific end tag, split content
    const content = this.queueStr.substring(0, endTagStart);

    // Send content to current element
    if (content.length > 0) {
      this.currentElement.parseChunk(content);
    }

    // Keep the part starting with the end tag for end tag processing
    this.queueStr = this.queueStr.substring(endTagStart);

    // Move to waiting for end state
    this.state = ProcessorState.WaitingForEnd;
    return true; // Continue processing
  }

  /**
   * Handle waiting for end tag state
   */
  private handleWaitingForEnd(): boolean {
    if (!this.currentElement) {
      return false; // Should not happen, but safety check
    }

    // Get the expected end tag for the current element
    const expectedEndTag = `</${this.currentElement.fullTagName}>`;

    // Wait for the complete specific end tag
    if (waitForChunks(this.queueStr, [expectedEndTag])) {
      const endTagIndex = this.queueStr.indexOf(expectedEndTag);

      // Extract the full end tag
      const fullEndTag = this.queueStr.substring(endTagIndex, endTagIndex + expectedEndTag.length);

      // Process and finalize element
      this.validateAndCompleteElement(fullEndTag);

      // Remove processed content from queue, keep remainder
      this.queueStr = this.queueStr.substring(endTagIndex + expectedEndTag.length);

      // Reset state and current element
      this.state = ProcessorState.WaitingForStart;
      this.currentElement = null;

      return true; // Continue processing
    }

    return false; // Wait for more chunks
  }

  /**
   * Find potential start of end tag at the end of queue string
   * Returns the index where potential end tag starts, or -1 if not found
   */
  private findPotentialEndTagStart(expectedEndTag: string): number {
    // Check for partial matches of the expected end tag at the end of queue
    for (let i = 1; i < expectedEndTag.length; i++) {
      const partial = expectedEndTag.substring(0, i);
      if (this.queueStr.endsWith(partial)) {
        return this.queueStr.length - partial.length;
      }
    }
    return -1;
  }

  /**
   * Validate end tag and complete the element
   */
  private validateAndCompleteElement(endTag: string): void {
    // Extract tag name from end tag (e.g., "</flow-test>" -> "flow-test")
    const endTagName = endTag.slice(2, -1).trim();

    if (this.currentElement) {
      if (this.currentElement.fullTagName === endTagName) {
        // Tags match - handle completion with partial support
        this.handleElementCompletion(this.currentElement);
        this.currentElement = null; // Clear current element after completion
      } else {
        // Tags don't match - log warning but continue processing gracefully
        console.warn(
          `FlowStreamProcessor: Mismatched tags: start tag '${this.currentElement.fullTagName}' vs end tag '${endTagName}' - continuing processing`,
        );
        // Still complete the element to avoid getting stuck
        this.handleElementCompletion(this.currentElement);
        this.currentElement = null; // Clear current element after completion
      }
    } else {
      // No element under processing - orphaned end tag, log warning but continue gracefully
      console.warn(`FlowStreamProcessor: Orphaned end tag: ${endTag} - ignoring`);
    }
  }

  /**
   * Handle element completion with group-channel support
   */
  private handleElementCompletion(element: FlowData): void {
    const groupId = element.groupId;

    // No group-id → standard completion (standalone element)
    if (!groupId) {
      element.parseElementData();
      this.emitCompletedElement(element);
      return;
    }

    // Has group-id → handle group-channel flow
    this.handleGroupChannelCompletion(element, groupId);
  }

  /**
   * Handle group-channel element logic
   */
  private handleGroupChannelCompletion(element: FlowData, groupId: string): void {
    // If we have a pending element (subsequent element in same channel), use it for attribute checks
    // Otherwise, use the element itself (first element)
    const newElement = this.pendingElement || element;
    const isFinal = newElement.isFinal;
    const channel = newElement.channel;

    // Clear pending element
    this.pendingElement = null;

    // Validate data-type is String
    if (element.dataType !== FlowDataType.String) {
      console.error(`[FlowStream] Partials only supported for String type, got: ${element.dataType}`);
      element.setError(`Partials not supported for ${element.dataType} type`);
      this.emitCompletedElement(element);
      return;
    }

    // Determine tracking key (same as in createElementFromStartTag)
    const trackingKey = channel ? new GroupChannelKey(element.elementType, groupId, channel).toString() : groupId;

    // Check if tracked
    if (!this.trackedGroups.has(trackingKey)) {
      // Not tracked - might be a group-level final for closing channels
      if (!channel && isFinal) {
        this.closeAllChannelsInGroup(groupId);
      }
      // Emit completion for standalone element
      element.parseElementData();
      this.emitCompletedElement(element);
      return;
    }

    // Get tracked FlowData
    const tracked = this.trackedGroups.get(trackingKey)!;

    // If this is a subsequent element, merge attributes
    if (newElement !== tracked) {
      // Validate compatibility
      if (newElement.elementType !== tracked.elementType || newElement.dataType !== tracked.dataType) {
        console.error(`[FlowStream] Partial mismatch for ${trackingKey}`);
        tracked.setError('Partial type mismatch');
        this.emitCompletedElement(tracked);
        this.trackedGroups.delete(trackingKey);
        if (channel) {
          this.removeChannelFromGroup(tracked.elementType, groupId, channel);
        }
        return;
      }

      // Merge attributes only (content already merged during parsing)
      this.mergeGroupChannelAttributes(tracked, newElement);
    }

    // Check if this is the final element
    if (isFinal) {
      tracked.parseElementData(); // Emits PARSED/READY
      this.emitCompletedElement(tracked);
      this.trackedGroups.delete(trackingKey);
      if (channel) {
        this.removeChannelFromGroup(tracked.elementType, groupId, channel);
      }
    }
    // else: Element closed but still waiting for final
  }

  /**
   * Close all channels in a group (called when group-level final arrives)
   */
  private closeAllChannelsInGroup(groupId: string): void {
    const channels = this.groupChannels.get(groupId);
    if (!channels) {
      return; // No channels to close
    }

    // Find and close all tracked elements belonging to this group
    const keysToDelete: string[] = [];
    for (const [trackingKey, flowData] of this.trackedGroups.entries()) {
      if (GroupChannelKey.belongsToGroup(trackingKey, groupId)) {
        flowData.parseElementData(); // Emits PARSED/READY
        this.emitCompletedElement(flowData);
        keysToDelete.push(trackingKey);
      }
    }

    // Delete all keys after iteration
    for (const key of keysToDelete) {
      this.trackedGroups.delete(key);
    }

    // Remove entire group from registry
    this.groupChannels.delete(groupId);
  }

  /**
   * Remove a specific channel from a group
   */
  private removeChannelFromGroup(elementType: string, groupId: string, channel: string): void {
    const compositeKey = new GroupChannelKey(elementType, groupId, channel).toString();
    this.trackedGroups.delete(compositeKey);

    const channels = this.groupChannels.get(groupId);
    if (channels) {
      channels.delete(channel);
      // If no more channels in group, remove group
      if (channels.size === 0) {
        this.groupChannels.delete(groupId);
      }
    }
  }

  /**
   * Merge attributes preserving once-attrs
   */
  private mergeGroupChannelAttributes(target: FlowData, source: FlowData): void {
    for (const [key, value] of Object.entries(source.attributes)) {
      if (!this.ONCE_ATTRS.includes(key)) {
        target.attributes[key] = value;
      }
    }
  }

  /**
   * Emit a completed element with all events
   */
  private emitCompletedElement(data: FlowData): void {
    // Emit all elements regardless of content - let the UI decide what to render
    // FlowData was already added to aggregatedEvents in createElementFromStartTag
    // Now we just update the existing reference (it's the same object)

    // Emit data:end event for element completion
    this.emit(FlowEvents.DATA_END, data);
    // Emit aggregated 'data:list' with all events so far (similar to flow system)
    this.emit(FlowEvents.DATA_LIST, [...this.aggregatedEvents]);

    // Emit stream:element_end
    this.emit(FlowEvents.STREAM_ELEMENT_END, data);
  }

  /**
   * Create element from start tag and emit stream:element_start
   */
  private createElementFromStartTag(tagString: string): void {
    // tagString is the content between < and > (without the brackets)
    // Extract just the tag name without attributes
    const cleanTagName = tagString.split(' ')[0];

    // Parse attributes from the tag
    const attributes = parseAttributes(tagString);

    // Create FlowData with initial data (content will be filled during streaming/parsing)
    // Use factory method to instantiate appropriate FlowData subclass
    const flowData = FlowDataFactory.fromElementType(
      cleanTagName, // Full tag name - elementType getter will strip prefix if present
      undefined,
      attributes,
    );

    // Set source to 'stream' for all FlowData created by streaming processor
    flowData.source = FlowDataSource.Stream;

    this.registerElementLogging(flowData);

    // Validate required attributes
    this.validateElementAttributes(flowData);

    const groupId = flowData.groupId;
    const channel = flowData.channel;

    // No group-id → standalone element (not tracked)
    if (!groupId) {
      this.currentElement = flowData;
      this.aggregatedEvents.push(flowData);
      this.emit(FlowEvents.STREAM_ELEMENT_START, flowData);
      this.emit(FlowEvents.DATA_START, flowData);
      this.emit(FlowEvents.DATA, flowData);
      return;
    }

    // Has group-id but no channel AND is final AND group has channels → group-level final marker
    // Only skip tracking if this group already has channels (shell-output pattern)
    // Otherwise, it's a regular element with group-id that should be tracked normally
    if (!channel && flowData.isFinal && this.groupChannels.has(groupId)) {
      this.currentElement = flowData;
      this.aggregatedEvents.push(flowData);
      this.emit(FlowEvents.STREAM_ELEMENT_START, flowData);
      this.emit(FlowEvents.DATA, flowData);
      return;
    }

    // Determine tracking key: group-id only OR element-type:group-id:channel composite
    const trackingKey = channel ? new GroupChannelKey(flowData.elementType, groupId, channel).toString() : groupId;

    // Check if already tracked
    if (this.trackedGroups.has(trackingKey)) {
      // Subsequent element - merge into existing
      this.pendingElement = flowData;
      this.currentElement = this.trackedGroups.get(trackingKey)!;
      return;
    }

    // First element with this tracking key - track it
    this.currentElement = flowData;

    // Check if adding this would exceed MAX_GROUPS limit
    if (this.trackedGroups.size >= this.MAX_GROUPS) {
      console.error(`[FlowStream] Max partials (${this.MAX_GROUPS}) exceeded, dropping: ${trackingKey}`);
      // Still set as currentElement so end tag processing works, but don't track or emit events
      return;
    }

    this.trackedGroups.set(trackingKey, flowData);

    // Track channel in group registry (if channel exists)
    if (channel) {
      if (!this.groupChannels.has(groupId)) {
        this.groupChannels.set(groupId, new Set());
      }
      this.groupChannels.get(groupId)!.add(channel);
    }

    this.aggregatedEvents.push(flowData);
    this.emit(FlowEvents.STREAM_ELEMENT_START, flowData);
    this.emit(FlowEvents.DATA, flowData);
  }

  private validateElementAttributes(element: FlowData): void {
    const missingAttrs: string[] = [];

    // Check for elementType
    if (!element.elementType) {
      missingAttrs.push('elementType');
    }

    // Note: 'data-type' and 'i' attributes are optional - data-type defaults to string

    if (missingAttrs.length > 0) {
      console.error(`FlowData validation failed - missing required attributes: ${missingAttrs.join(', ')}`, {
        elementType: element.elementType,
        attributes: element.attributes,
        index: element.index,
      });
    }
  }

  /**
   * Reset the processor state to initial values
   * This method resets all properties to their initial state, making it equivalent to creating a new instance
   */
  reset(): void {
    this.queueStr = '';
    this.state = ProcessorState.WaitingForStart;
    this.currentElement = null;
    this.isStreaming = false;
    this.aggregatedText = '';
    this.aggregatedEvents = [];
    this.trackedGroups = new Map<string, FlowData>();
    this.groupChannels = new Map<string, Set<string>>();
    this.pendingElement = null;
  }

  /**
   * Get the current queue content (for debugging)
   */
  getBuffer(): string {
    return this.queueStr;
  }

  /**
   * Get the aggregated text content
   */
  getAggregatedText(): string {
    return this.aggregatedText;
  }

  /**
   * Get all aggregated events
   */
  getAggregatedEvents(): FlowData[] {
    return [...this.aggregatedEvents];
  }

  /**
   * Get all elements (alias for getAggregatedEvents for compatibility)
   */
  get elements(): FlowData[] {
    return [...this.aggregatedEvents];
  }

  /**
   * Get the current event count
   */
  getEventCount(): number {
    return this.aggregatedEvents.length;
  }

  /**
   * Signal that the stream has ended
   * If there's an element under processing that's not ready, emit an 'incomplete stream' error
   */
  endStream(): void {
    const hasIncompleteElement = this.currentElement && !this.currentElement.ready;
    // Ignore whitespace-only content (formatting whitespace in XML is normal)
    const hasUnprocessedContent = this.queueStr.trim().length > 0;

    // Check for orphaned groups
    if (this.trackedGroups.size > 0) {
      const orphaned = Array.from(this.trackedGroups.keys());
      console.warn(`[FlowStream] Stream ended with ${orphaned.length} incomplete partials:`, orphaned);
      this.trackedGroups.clear();
      this.groupChannels.clear();
    }

    // Emit a single error for incomplete stream if either condition exists
    if (hasIncompleteElement || hasUnprocessedContent) {
      let message = 'incomplete stream';
      const details: string[] = [];

      if (hasIncompleteElement) {
        details.push(`partial element: ${this.currentElement?.elementType || 'unknown'}`);
      }

      if (hasUnprocessedContent) {
        details.push(`unprocessed content: ${this.queueStr.substring(0, 50)}`);
      }

      if (details.length > 0) {
        message += ` (${details.join(', ')})`;
      }

      const errorEvent = FlowErrorUtils.createErrorEvent(FlowError.INCOMPLETE_STREAM, message);
      this.emit(FlowEvents.ERROR, errorEvent);
    }

    this.isStreaming = false;
    this.emit(FlowEvents.STREAM_END);
  }

  abortStream(): void {
    this.isStreaming = false;
    this.emit(FlowEvents.STREAM_CANCEL);
  }
}
