/**
 * Tests for MockXMLStreamer operator functionality
 *
 * This file tests streaming operators like |break| that control test execution.
 * Operators are future-proof: |operator:value| pattern supports extensibility.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../utils/stub/agentic_process_mock';
import { parseChunksParts } from './mock_flow_streamer_test_utils';

describe('MockChunkParser - Unit Tests', () => {
  it('should emit simple text without delimiter normally', () => {
    const input = 'some text without delimiter';
    const chunks = parseChunksParts(input);

    expect(chunks.length).toBe(1);
    expect(chunks[0].type).toBe('stream');
    expect(chunks[0].content).toBe('some text without delimiter');
  });

  it('should emit single 0-length string for ||', () => {
    const input = '||';
    const chunks = parseChunksParts(input);

    // || is just a delimiter with no content - no chunks emitted
    expect(chunks.length).toBe(0);
  });

  it('should handle ||||hi|| yielding [0-length, "hi", 0-length]', () => {
    const input = '||||hi||';
    const chunks = parseChunksParts(input);

    // ||||hi|| = || (emit empty) || (emit empty) hi || (emit "hi") (nothing after)
    // Actually: || || hi ||
    // First ||: emit nothing (no content before)
    // Second ||: emit nothing (no content between)
    // hi: content
    // Third ||: emit "hi"
    // Result: no chunks before first ||, no chunks between first and second ||, "hi" chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0].type).toBe('stream');
    expect(chunks[0].content).toBe('hi');
  });

  it('should correctly parse |break| format', () => {
    const input = 'first|break|second';
    const chunks = parseChunksParts(input);

    expect(chunks.length).toBe(3);
    expect(chunks[0].type).toBe('stream');
    expect(chunks[0].content).toBe('first');
    expect(chunks[1].type).toBe('operator');
    expect(chunks[1].operator?.type).toBe('BREAK');
    expect(chunks[2].type).toBe('stream');
    expect(chunks[2].content).toBe('second');
  });

  it('should handle content|operator|content format', () => {
    const input = 'before|nop|after';
    const chunks = parseChunksParts(input);

    expect(chunks.length).toBe(3);
    expect(chunks[0].type).toBe('stream');
    expect(chunks[0].content).toBe('before');
    expect(chunks[1].type).toBe('operator');
    expect(chunks[1].operator?.type).toBe('NOP');
    expect(chunks[2].type).toBe('stream');
    expect(chunks[2].content).toBe('after');
  });

  it('should ignore operators longer than MAX_OPERATOR_CHARS', () => {
    const input = 'text|verylongoperatornamethatexceedstwentycharacters|more';
    const chunks = parseChunksParts(input);

    // Should treat entire thing as content since operator is too long
    expect(chunks.length).toBe(1);
    expect(chunks[0].type).toBe('stream');
    expect(chunks[0].content).toBe('text|verylongoperatornamethatexceedstwentycharacters|more');
  });

  it('should treat unknown operators as NOP', () => {
    const input = 'before|unknown|after';
    const chunks = parseChunksParts(input);

    expect(chunks.length).toBe(3);
    expect(chunks[0].type).toBe('stream');
    expect(chunks[0].content).toBe('before');
    expect(chunks[1].type).toBe('operator');
    expect(chunks[1].operator?.type).toBe('NOP'); // Unknown -> NOP
    expect(chunks[2].type).toBe('stream');
    expect(chunks[2].content).toBe('after');
  });
});

describe('MockXMLStreamer - Operator Tests', () => {
  let flowMock: FlowMock;
  let testCounter = 0;

  beforeEach(() => {
    // Use unique ID for each test to avoid entity registration conflicts
    const processId = `550e8400-e29b-41d4-a716-${String(446655440000 + testCounter++).padStart(12, '0')}`;
    flowMock = new FlowMock({ id: processId });
    flowMock.streamChunkDelay = 10; // Fast streaming for tests
  });

  it('should pause at |break| operator and resume on continue', async () => {
    // XML with breakpoint after first chunk
    const mockXML =
      '<flow-text i="1" t="2025-01-01T10:00:00Z">First chunk</flow-text>' +
      '||' +
      '|break|' +
      '<flow-text i="2" t="2025-01-01T10:00:01Z">Second chunk</flow-text>' +
      '||' +
      '<flow-text i="3" t="2025-01-01T10:00:02Z">Third chunk</flow-text>';

    flowMock.setMockStreamXML(mockXML);

    // Start streaming (don't await - it will hang at breakpoint)
    void flowMock.sendMessage('test');

    // Wait for first chunk to be processed and breakpoint to be hit
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Check stream items - should have first chunk only
    const streamItems = flowMock.stream.items.filter((item) => item.elementType === 'text');
    expect(streamItems.length).toBe(1);
    expect(streamItems[0].content).toBe('First chunk');
    expect(flowMock.isAtBreakpoint()).toBe(true);

    // Continue from breakpoint
    await flowMock.continueStreaming();

    // Wait for remaining chunks
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should now have all chunks
    const allStreamItems = flowMock.stream.items.filter((item) => item.elementType === 'text');
    expect(allStreamItems.length).toBe(3);
    expect(allStreamItems[0].content).toBe('First chunk');
    expect(allStreamItems[1].content).toBe('Second chunk');
    expect(allStreamItems[2].content).toBe('Third chunk');
    expect(flowMock.isAtBreakpoint()).toBe(false);
  });

  it('should handle multiple |break| operators in sequence', async () => {
    // XML with multiple breakpoints
    const mockXML =
      '<flow-text i="1" t="2025-01-01T10:00:00Z">Chunk A</flow-text>' +
      '||' +
      '|break|' +
      '<flow-text i="2" t="2025-01-01T10:00:01Z">Chunk B</flow-text>' +
      '||' +
      '|break|' +
      '<flow-text i="3" t="2025-01-01T10:00:02Z">Chunk C</flow-text>';

    flowMock.setMockStreamXML(mockXML);

    // Start streaming
    const sendPromise = flowMock.sendMessage('test');
    await new Promise((resolve) => setTimeout(resolve, 150));

    // First breakpoint: should have Chunk A only
    let streamItems = flowMock.stream.items.filter((item) => item.elementType === 'text');
    expect(streamItems.length).toBe(1);
    expect(streamItems[0].content).toBe('Chunk A');
    expect(flowMock.isAtBreakpoint()).toBe(true);

    // Continue to second breakpoint
    await flowMock.continueStreaming();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Second breakpoint: should have A and B, but not C
    streamItems = flowMock.stream.items.filter((item) => item.elementType === 'text');
    expect(streamItems.length).toBe(2);
    expect(streamItems[0].content).toBe('Chunk A');
    expect(streamItems[1].content).toBe('Chunk B');
    expect(flowMock.isAtBreakpoint()).toBe(true);

    // Continue to end
    await flowMock.continueStreaming();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // All chunks present, no more breakpoints
    streamItems = flowMock.stream.items.filter((item) => item.elementType === 'text');
    expect(streamItems.length).toBe(3);
    expect(streamItems[0].content).toBe('Chunk A');
    expect(streamItems[1].content).toBe('Chunk B');
    expect(streamItems[2].content).toBe('Chunk C');
    expect(flowMock.isAtBreakpoint()).toBe(false);

    // Wait for send to complete
    await sendPromise;
  });

  it('should NOT create extra chunks with |break| format', async () => {
    // Validate that |break| doesn't create space chunks
    const mockXML =
      '<flow-text i="1" t="2025-01-01T10:00:00Z">First</flow-text>' +
      '||' +
      '|break|' +
      '<flow-text i="2" t="2025-01-01T10:00:01Z">Second</flow-text>';

    flowMock.setMockStreamXML(mockXML);

    // Start streaming
    void flowMock.sendMessage('test');
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should hit breakpoint with ONLY "First" chunk, no space chunks
    const streamItems = flowMock.stream.items;
    const textItems = streamItems.filter((item) => item.elementType === 'text');
    expect(textItems.length).toBe(1);
    expect(textItems[0].content).toBe('First');
    expect(flowMock.isAtBreakpoint()).toBe(true);

    // Verify NO extra space chunks were created
    const spaceChunks = textItems.filter((item) => item.content === ' ' || item.content?.trim() === '');
    expect(spaceChunks.length).toBe(0);

    // Continue and verify second chunk
    await flowMock.continueStreaming();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const finalTextItems = flowMock.stream.items.filter((item) => item.elementType === 'text');
    expect(finalTextItems.length).toBe(2);
    expect(finalTextItems[0].content).toBe('First');
    expect(finalTextItems[1].content).toBe('Second');

    // Still no space chunks
    const finalSpaceChunks = finalTextItems.filter((item) => item.content === ' ' || item.content?.trim() === '');
    expect(finalSpaceChunks.length).toBe(0);
  });
});
