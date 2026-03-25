/**
 * Mock Flow Streamer Test Utilities
 * Provides utilities for simulating XML streaming with random chunking
 */

/**
 * Exception thrown when streamer hits a breakpoint
 * Tests can catch this to know when to pause and validate state
 */
export class StreamBreakpointError extends Error {
  constructor(
    message: string = 'Stream paused at breakpoint',
    public readonly chunkIndex: number = 0,
  ) {
    super(message);
    this.name = 'StreamBreakpointError';
  }
}

// Seeded pseudo-random number generator
class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    // Simple LCG (Linear Congruential Generator)
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

// Chunk emission marker constant
const CHUNK_MARKER = '||';

// Maximum operator name length (including potential :value)
const MAX_OPERATOR_CHARS = 20;

// Operator pattern: |operator_name| or |operator_name:value|
const OPERATOR_PATTERN = /^\|([^|:]+)(?::([^|]+))?\|$/;

/**
 * Mock chunk types
 */
type MockChunkType = 'stream' | 'operator';

/**
 * Parse XML content into MockChunk array
 * Handles chunk delimiters (||) and operators (|operator|)
 *
 * Algorithm:
 * 1. Search for opening | and closing | in text
 * 2. If operator between pipes is > MAX_OPERATOR_CHARS, treat as content
 * 3. If valid operator but unknown, store as NOP with console.warn
 * 4. || delimiter emits current chunk
 */
export function parseChunksParts(xmlContent: string): MockChunk[] {
  // Always scan for operators and chunk delimiters
  const chunks: MockChunk[] = [];
  const streamContentParts: string[] = [];
  let i = 0;
  let currentPart = '';

  while (i < xmlContent.length) {
    // Check for chunk delimiter ||
    if (i < xmlContent.length - 1 && xmlContent[i] === '|' && xmlContent[i + 1] === '|') {
      // Found delimiter - emit current part if non-empty
      if (currentPart.length > 0) {
        chunks.push({ type: 'stream', content: currentPart });
        streamContentParts.push(currentPart);
        currentPart = '';
      }
      i += 2; // Skip both pipes
      continue;
    }

    // Check for potential operator |...|
    if (xmlContent[i] === '|') {
      // Look ahead for closing | within MAX_OPERATOR_CHARS
      let closingIndex = -1;
      for (let j = i + 1; j <= Math.min(i + MAX_OPERATOR_CHARS, xmlContent.length - 1); j++) {
        if (xmlContent[j] === '|') {
          closingIndex = j;
          break;
        }
      }

      if (closingIndex !== -1) {
        // Found potential operator
        const potentialOperator = xmlContent.substring(i, closingIndex + 1);
        const trimmed = potentialOperator.trim();
        const operatorMatch = trimmed.match(OPERATOR_PATTERN);

        if (operatorMatch) {
          // Valid operator! Emit current part if any
          if (currentPart.length > 0) {
            chunks.push({ type: 'stream', content: currentPart });
            streamContentParts.push(currentPart);
            currentPart = '';
          }

          // Map operator name to MockOpType
          const operatorName = operatorMatch[1].toUpperCase();
          const operatorValue = operatorMatch[2];

          let opType: MockOpType;
          if (operatorName === 'BREAK') {
            opType = 'BREAK';
          } else if (operatorName === 'NOP') {
            opType = 'NOP';
          } else {
            // Unknown operators default to NOP
            console.warn(`[MockXMLStreamer] Unknown operator: ${operatorName}, treating as NOP`);
            opType = 'NOP';
          }

          chunks.push({
            type: 'operator',
            operator: {
              type: opType,
              value: operatorValue,
            },
          });

          // Skip past the operator
          i = closingIndex + 1;
          continue;
        }
      }
    }

    // Not an operator or delimiter - add to current part
    currentPart += xmlContent[i];
    i++;
  }

  // Add remaining part if any
  if (currentPart.length > 0) {
    chunks.push({ type: 'stream', content: currentPart });
    streamContentParts.push(currentPart);
  }

  return chunks;
}

/**
 * Operator types for MockXMLStreamer
 */
type MockOpType = 'NOP' | 'BREAK';

/**
 * Represents a single chunk in the stream (either content or operator)
 */
interface MockChunk {
  type: MockChunkType;
  content?: string; // For stream chunks
  operator?: {
    type: MockOpType;
    value?: string; // For future operators like |delay:100|
  };
}

/**
 * Mock XML Stream utility that simulates server streaming behavior
 * Takes XML content and streams it in random chunks
 * Supports chunk emission markers || for grouping content into specific chunks
 * Supports streaming operators like |break| for test control
 */
export class MockXMLStreamer {
  private xmlContent: string = '';
  private position: number = 0;
  private random: SeededRandom;
  private chunks: MockChunk[] = [];
  private chunkIndex: number = 0;
  private useMarkerMode: boolean = false;
  private atBreakpoint: boolean = false;

  constructor(xmlContent: string, seed: number = 12345) {
    this.parseChunks(xmlContent);
    this.random = new SeededRandom(seed);
  }

  /**
   * Parse XML into MockChunk array
   * Uses parseChunksParts function to handle delimiters and operators
   */
  private parseChunks(xmlContent: string): void {
    this.chunks = parseChunksParts(xmlContent);
    this.useMarkerMode = xmlContent.includes(CHUNK_MARKER);

    // Extract only stream content (no operators, no markers) for xmlContent
    this.xmlContent = this.chunks
      .filter((chunk) => chunk.type === 'stream')
      .map((chunk) => chunk.content!)
      .join('');
  }

  /**
   * Get the next chunk of XML content
   * Iterates through MockChunk array, skipping NOP operators and throwing on BREAK
   */
  get_next_chunk(): string | null {
    if (this.useMarkerMode) {
      // Check if we're paused at a breakpoint
      if (this.atBreakpoint) {
        throw new StreamBreakpointError(`Stream paused at breakpoint (chunk ${this.chunkIndex})`, this.chunkIndex);
      }

      // Iterate through chunks
      while (this.chunkIndex < this.chunks.length) {
        const chunk = this.chunks[this.chunkIndex];
        this.chunkIndex++;

        if (chunk.type === 'operator') {
          // Handle operator chunk
          if (chunk.operator!.type === 'BREAK') {
            this.atBreakpoint = true;
            throw new StreamBreakpointError(
              `Stream paused at breakpoint (chunk ${this.chunkIndex - 1})`,
              this.chunkIndex - 1,
            );
          } else if (chunk.operator!.type === 'NOP') {
            // Skip NOP operator, continue to next chunk
            continue;
          }
        } else if (chunk.type === 'stream') {
          // Return stream content
          return chunk.content!;
        }
      }

      // End of stream
      return null;
    } else {
      // Original random chunking behavior
      if (this.position >= this.xmlContent.length) {
        return null; // End of stream
      }

      // Generate random chunk size between 1 and 10 characters
      const remainingLength = this.xmlContent.length - this.position;
      const maxChunkSize = Math.min(10, remainingLength);
      const chunkSize = this.random.nextInt(1, maxChunkSize);

      const chunk = this.xmlContent.slice(this.position, this.position + chunkSize);
      this.position += chunkSize;

      return chunk;
    }
  }

  /**
   * Continue from a breakpoint
   * Clears the breakpoint flag to resume streaming
   */
  continue(): void {
    this.atBreakpoint = false;
  }

  /**
   * Add more XML content to the stream
   * @param additionalXml Additional XML to append to the stream
   */
  addToStream(additionalXml: string): void {
    if (this.useMarkerMode) {
      // Parse additional XML for markers and add to chunks
      if (additionalXml.includes(CHUNK_MARKER)) {
        const newParts = additionalXml.split(CHUNK_MARKER).filter((part) => part.length > 0);

        newParts.forEach((part) => {
          const trimmedPart = part.trim();
          const operatorMatch = trimmedPart.match(OPERATOR_PATTERN);

          if (operatorMatch) {
            const operatorName = operatorMatch[1].toUpperCase();
            const operatorValue = operatorMatch[2];

            let opType: MockOpType;
            if (operatorName === 'BREAK') {
              opType = 'BREAK';
            } else if (operatorName === 'NOP') {
              opType = 'NOP';
            } else {
              console.warn(`[MockXMLStreamer] Unknown operator: ${operatorName}, treating as NOP`);
              opType = 'NOP';
            }

            this.chunks.push({
              type: 'operator',
              operator: {
                type: opType,
                value: operatorValue,
              },
            });
          } else {
            this.chunks.push({
              type: 'stream',
              content: part,
            });
            this.xmlContent += part;
          }
        });
      } else {
        // Add as single stream chunk if no markers
        this.chunks.push({
          type: 'stream',
          content: additionalXml,
        });
        this.xmlContent += additionalXml;
      }
    } else {
      // In random mode, just append to content
      this.xmlContent += additionalXml;
    }
  }

  /**
   * Reset the streamer to start from beginning
   */
  reset(): void {
    this.position = 0;
    this.chunkIndex = 0;
    this.atBreakpoint = false;
  }

  /**
   * Check if there's more content to stream
   */
  hasMore(): boolean {
    if (this.useMarkerMode) {
      return this.chunkIndex < this.chunks.length;
    } else {
      return this.position < this.xmlContent.length;
    }
  }

  /**
   * Get all remaining content (useful for debugging)
   */
  getRemainingContent(): string {
    if (this.useMarkerMode) {
      return this.chunks
        .slice(this.chunkIndex)
        .filter((chunk) => chunk.type === 'stream')
        .map((chunk) => chunk.content!)
        .join('');
    } else {
      return this.xmlContent.slice(this.position);
    }
  }

  /**
   * Create a ReadableStream from this MockXMLStreamer
   * Returns a ReadableStream<Uint8Array> that can be used with stream processors
   */
  readableStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const streamer = this;

    return new ReadableStream({
      start: (controller) => {
        const pushChunk = () => {
          try {
            const chunk = streamer.get_next_chunk();
            if (chunk !== null) {
              controller.enqueue(encoder.encode(chunk));
              // Push next chunk asynchronously
              setTimeout(pushChunk, 0);
            } else {
              controller.close();
            }
          } catch (error) {
            controller.error(error);
          }
        };

        pushChunk();
      },
    });
  }
}

/**
 * Helper function to create a mock streamer with predefined XML content
 */
export function createMockStreamer(xmlContent: string, seed?: number): MockXMLStreamer {
  const streamer = new MockXMLStreamer(xmlContent, seed);
  let allText = '';
  while (streamer.hasMore()) {
    const chunk = streamer.get_next_chunk();
    if (chunk !== null) {
      allText += chunk;
    }
  }

  // Compare with the processed content (markers removed), not the original input
  const expectedContent = xmlContent.replace(new RegExp(CHUNK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
  if (allText !== expectedContent) {
    console.log('DEBUG - allText:', JSON.stringify(allText));
    console.log('DEBUG - expectedContent:', JSON.stringify(expectedContent));
    console.log('DEBUG - originalContent:', JSON.stringify(xmlContent));
    throw new Error('Mock chunker error: All text does not match original content');
  }

  return new MockXMLStreamer(xmlContent, seed);
}

/**
 * Helper to collect all chunks from a streamer (for testing)
 */
export function collectAllChunks(streamer: MockXMLStreamer): string[] {
  const chunks: string[] = [];
  let chunk = streamer.get_next_chunk();

  while (chunk !== null) {
    chunks.push(chunk);
    chunk = streamer.get_next_chunk();
  }

  return chunks;
}

/**
 * Helper to verify that chunks reconstruct to original content
 */
export function verifyChunksReconstruct(chunks: string[], originalContent: string): boolean {
  return chunks.join('') === originalContent;
}
