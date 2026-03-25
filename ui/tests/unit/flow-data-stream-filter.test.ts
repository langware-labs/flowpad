import { describe, it, expect } from 'vitest';
import { FlowDataStream, SubstreamFilter } from '@sdk/flow_processing/flow-data-stream';
import { FlowData } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { FlowStreamProcessor } from '@sdk/flow_processing/flow-stream-processor';
import { FlowEvents } from '@sdk/flow_processing/flow-events';

describe('FlowDataStream substream filtering', () => {
  it('filters substream items by element type array (whitelist)', () => {
    // Create main stream
    const mainStream = new FlowDataStream('Main Stream');

    // Create substream with various element types
    const substream = new FlowDataStream('Test Substream');

    // Add different types of FlowData items
    const textItem = new FlowData(FlowElementTypes.TEXT, 'Hello', {
      i: '0',
      t: new Date('2025-01-01T10:00:00Z').toISOString(),
    });

    const shellItem = new FlowData(FlowElementTypes.SHELL, 'ls -la', {
      i: '1',
      t: new Date('2025-01-01T10:00:01Z').toISOString(),
    });

    const errorItem = new FlowData(FlowElementTypes.ERROR, 'Something failed', {
      i: '2',
      t: new Date('2025-01-01T10:00:02Z').toISOString(),
    });

    const resultItem = new FlowData(FlowElementTypes.RESULT, '{"status": "ok"}', {
      i: '3',
      t: new Date('2025-01-01T10:00:03Z').toISOString(),
    });

    substream.append([textItem, shellItem, errorItem, resultItem]);

    // Add substream with whitelist filter - only TEXT and RESULT types
    const filter: SubstreamFilter = [FlowElementTypes.TEXT, FlowElementTypes.RESULT];
    mainStream.addSubstream(substream, filter);

    // Get items from main stream (should only include TEXT and RESULT)
    const items = mainStream.items;

    expect(items).toHaveLength(2);
    expect(items[0].elementType).toBe(FlowElementTypes.TEXT);
    expect(items[1].elementType).toBe(FlowElementTypes.RESULT);

    // Verify filtered items are excluded
    const shellExists = items.some((item) => item.elementType === FlowElementTypes.SHELL);
    const errorExists = items.some((item) => item.elementType === FlowElementTypes.ERROR);
    expect(shellExists).toBe(false);
    expect(errorExists).toBe(false);
  });

  it('filters substream items by function filter with error handling', () => {
    // Create main stream
    const mainStream = new FlowDataStream('Main Stream');

    // Create substream
    const substream = new FlowDataStream('Test Substream');

    // Add FlowData items
    const item1 = new FlowData(FlowElementTypes.TEXT, 'Include this', {
      i: '0',
      t: new Date('2025-01-01T10:00:00Z').toISOString(),
    });

    const item2 = new FlowData(FlowElementTypes.TEXT, 'Filter this out', {
      i: '1',
      t: new Date('2025-01-01T10:00:01Z').toISOString(),
    });

    const item3 = new FlowData(FlowElementTypes.SHELL, 'echo "hello"', {
      i: '2',
      t: new Date('2025-01-01T10:00:02Z').toISOString(),
    });

    const item4 = new FlowData(FlowElementTypes.ERROR, 'Trigger error', {
      i: '3',
      t: new Date('2025-01-01T10:00:03Z').toISOString(),
    });

    substream.append([item1, item2, item3, item4]);

    // Mock console.error to verify error handling
    const originalConsoleError = console.error;
    const consoleErrors: any[] = [];
    console.error = (...args: any[]) => {
      consoleErrors.push(args);
    };

    // Function filter that:
    // - Returns item for TEXT containing "Include"
    // - Returns null for TEXT containing "Filter"
    // - Returns item for SHELL
    // - Throws error for ERROR type (should be filtered and logged)
    const filter: SubstreamFilter = (item: FlowData) => {
      if (item.elementType === FlowElementTypes.TEXT) {
        if ((item.rawData as string).includes('Include')) {
          return item;
        }
        return null; // Filter out
      }
      if (item.elementType === FlowElementTypes.SHELL) {
        return item;
      }
      if (item.elementType === FlowElementTypes.ERROR) {
        throw new Error('Intentional error for testing');
      }
      return null;
    };

    mainStream.addSubstream(substream, filter);

    // Get items from main stream
    const items = mainStream.items;

    // Should have 2 items: item1 (TEXT with "Include") and item3 (SHELL)
    // item2 filtered by returning null, item4 filtered due to exception
    expect(items).toHaveLength(2);
    expect(items[0].elementType).toBe(FlowElementTypes.TEXT);
    expect(items[0].rawData).toBe('Include this');
    expect(items[1].elementType).toBe(FlowElementTypes.SHELL);

    // Verify error was logged
    expect(consoleErrors.length).toBeGreaterThan(0);
    const errorLog = consoleErrors.find((log) =>
      log.some((arg: any) => typeof arg === 'string' && arg.includes('Error in substream filter function')),
    );
    expect(errorLog).toBeDefined();

    // Restore console.error
    console.error = originalConsoleError;
  });

  it('count respects filters (critical bug test)', () => {
    const mainStream = new FlowDataStream('Main Stream');
    const substream = new FlowDataStream('Test Substream');

    // Add 4 items, filter to only 2
    const item1 = new FlowData(FlowElementTypes.TEXT, 'text1', {
      i: '0',
      t: new Date('2025-01-01T10:00:00Z').toISOString(),
    });
    const item2 = new FlowData(FlowElementTypes.SHELL, 'shell1', {
      i: '1',
      t: new Date('2025-01-01T10:00:01Z').toISOString(),
    });
    const item3 = new FlowData(FlowElementTypes.ERROR, 'error1', {
      i: '2',
      t: new Date('2025-01-01T10:00:02Z').toISOString(),
    });
    const item4 = new FlowData(FlowElementTypes.TEXT, 'text2', {
      i: '3',
      t: new Date('2025-01-01T10:00:03Z').toISOString(),
    });

    substream.append([item1, item2, item3, item4]);

    // Filter to only TEXT items (2 out of 4)
    const filter: SubstreamFilter = [FlowElementTypes.TEXT];
    mainStream.addSubstream(substream, filter);

    // Critical: count should reflect filtered items, not total items
    expect(mainStream.count).toBe(2);
    expect(mainStream.items.length).toBe(2);
    expect(substream.count).toBe(4); // Substream itself has all 4
  });

  it('filters items added dynamically after filter is set', () => {
    const mainStream = new FlowDataStream('Main Stream');
    const substream = new FlowDataStream('Test Substream');

    // Add initial item
    const item1 = new FlowData(FlowElementTypes.TEXT, 'initial', {
      i: '0',
      t: new Date('2025-01-01T10:00:00Z').toISOString(),
    });
    substream.append(item1);

    // Set filter before adding more items
    const filter: SubstreamFilter = [FlowElementTypes.TEXT];
    mainStream.addSubstream(substream, filter);

    expect(mainStream.items.length).toBe(1);
    expect(mainStream.count).toBe(1);

    // Dynamically add items after filter is set
    const item2 = new FlowData(FlowElementTypes.SHELL, 'should be filtered', {
      i: '1',
      t: new Date('2025-01-01T10:00:01Z').toISOString(),
    });
    const item3 = new FlowData(FlowElementTypes.TEXT, 'should pass', {
      i: '2',
      t: new Date('2025-01-01T10:00:02Z').toISOString(),
    });

    substream.append([item2, item3]);

    // Critical: newly added items should be filtered
    expect(mainStream.items.length).toBe(2); // Only 2 TEXT items
    expect(mainStream.count).toBe(2);
    expect(mainStream.items[0].elementType).toBe(FlowElementTypes.TEXT);
    expect(mainStream.items[1].elementType).toBe(FlowElementTypes.TEXT);
  });

  it('handles nested substreams with filters correctly', () => {
    // Create hierarchy: Main -> Sub1 (filter) -> Sub2 (filter)
    const mainStream = new FlowDataStream('Main');
    const sub1 = new FlowDataStream('Sub1');
    const sub2 = new FlowDataStream('Sub2');

    // Add various items to sub2 (deepest level)
    const text1 = new FlowData(FlowElementTypes.TEXT, 'text', {
      i: '0',
      t: new Date('2025-01-01T10:00:00Z').toISOString(),
    });
    const shell1 = new FlowData(FlowElementTypes.SHELL, 'shell', {
      i: '1',
      t: new Date('2025-01-01T10:00:01Z').toISOString(),
    });
    const error1 = new FlowData(FlowElementTypes.ERROR, 'error', {
      i: '2',
      t: new Date('2025-01-01T10:00:02Z').toISOString(),
    });
    const result1 = new FlowData(FlowElementTypes.RESULT, 'result', {
      i: '3',
      t: new Date('2025-01-01T10:00:03Z').toISOString(),
    });

    sub2.append([text1, shell1, error1, result1]);

    // Sub1 filters Sub2 to only TEXT and RESULT (2 items)
    const filter1: SubstreamFilter = [FlowElementTypes.TEXT, FlowElementTypes.RESULT];
    sub1.addSubstream(sub2, filter1);

    // Main filters Sub1 to only TEXT (1 item)
    const filter2: SubstreamFilter = [FlowElementTypes.TEXT];
    mainStream.addSubstream(sub1, filter2);

    // Critical: filters should stack correctly
    expect(mainStream.items.length).toBe(1);
    expect(mainStream.count).toBe(1);
    expect(mainStream.items[0].elementType).toBe(FlowElementTypes.TEXT);

    // Sub1 should see 2 items (TEXT + RESULT from sub2)
    expect(sub1.items.length).toBe(2);

    // Sub2 should see all 4 items
    expect(sub2.items.length).toBe(4);
  });

  it('filters USER_MESSAGE from message substream (simulates Flow.sendMessage behavior)', async () => {
    // Mock XML response from server (simulates what Flow receives after sendMessage)
    const mockXml = `<flow-user-message i="1311" t="2025-10-27T17:05:09.351019+00:00" data-type="string">/shell echo hi </flow-user-message>
<flow-focus i="1312" t="2025-10-27T17:05:28.250581+00:00" data-type="string" previous-focus="chat">shell</flow-focus>
<flow-status i="1313" t="2025-10-27T17:05:28.251078+00:00" data-type="string">Executing shell command...</flow-status>
<flow-shell-input i="1314" t="2025-10-27T17:05:28.251799+00:00" focus="shell" data-type="string" workdir="~">echo hi</flow-shell-input>
<flow-shell-output i="1315" t="2025-10-27T17:05:30.531903+00:00" focus="shell" data-type="string" stream="stdout">hi
</flow-shell-output>
<flow-focus i="1316" t="2025-10-27T17:05:30.532939+00:00" data-type="string" previous-focus="shell">chat</flow-focus>`;

    // Parse XML using FlowStreamProcessor
    const processor = new FlowStreamProcessor();
    const parsedItems: FlowData[] = [];

    processor.on(FlowEvents.DATA, (flowData: FlowData) => {
      parsedItems.push(flowData);
    });

    processor.process_chunk(mockXml);
    processor.endStream();

    // Verify we parsed all items including USER_MESSAGE
    expect(parsedItems.length).toBe(6);
    expect(parsedItems[0].elementType).toBe(FlowElementTypes.USER_MESSAGE);
    expect(parsedItems[1].elementType).toBe(FlowElementTypes.FOCUS);
    expect(parsedItems[2].elementType).toBe(FlowElementTypes.STATUS);
    expect(parsedItems[3].elementType).toBe(FlowElementTypes.SHELL_INPUT);
    expect(parsedItems[4].elementType).toBe(FlowElementTypes.SHELL_OUTPUT);
    expect(parsedItems[5].elementType).toBe(FlowElementTypes.FOCUS);

    // Simulate Flow.sendMessage behavior:
    // 1. Create main stream (represents flow._stream)
    const mainStream = new FlowDataStream('flow-main');

    // 2. Create current message stream (represents flow._currentMessageStream)
    const currentMessageStream = new FlowDataStream('message-shell-echo-hi');

    // 3. Append all items to current message stream (including USER_MESSAGE)
    currentMessageStream.append(parsedItems);

    // 4. Add current message stream to main stream WITH filter (filters out USER_MESSAGE)
    const filter: SubstreamFilter = (item: FlowData) => {
      return item.elementType === FlowElementTypes.USER_MESSAGE ? null : item;
    };
    mainStream.addSubstream(currentMessageStream, filter);

    // CRITICAL ASSERTION: main stream should NOT contain USER_MESSAGE
    const mainStreamItems = mainStream.items;
    expect(mainStreamItems.length).toBe(5); // 6 items - 1 USER_MESSAGE = 5

    // Verify USER_MESSAGE is filtered out
    const hasUserMessage = mainStreamItems.some((item) => item.elementType === FlowElementTypes.USER_MESSAGE);
    expect(hasUserMessage).toBe(false);

    // Verify all other items are present
    expect(mainStreamItems[0].elementType).toBe(FlowElementTypes.FOCUS);
    expect(mainStreamItems[1].elementType).toBe(FlowElementTypes.STATUS);
    expect(mainStreamItems[2].elementType).toBe(FlowElementTypes.SHELL_INPUT);
    expect(mainStreamItems[3].elementType).toBe(FlowElementTypes.SHELL_OUTPUT);
    expect(mainStreamItems[4].elementType).toBe(FlowElementTypes.FOCUS);

    // Verify currentMessageStream still contains USER_MESSAGE (not filtered at source)
    expect(currentMessageStream.items.length).toBe(6);
    expect(currentMessageStream.items[0].elementType).toBe(FlowElementTypes.USER_MESSAGE);
  });
});
