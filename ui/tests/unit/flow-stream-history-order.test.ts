import { dataManager, FlowElementTypes } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../utils/test-utils';
import { mockCallAction } from './testSetup';

const callAction = dataManager.callAction.bind(dataManager);
/**
 * Unit test to validate flow.stream items are ordered by TIME
 * when loading history with shell commands
 */
describe('Flow Stream History Order - Shell Commands', () => {
  beforeEach(async () => {
    await unitTestSetup();
    dataManager.callAction = vi.fn().mockImplementation(mockCallAction);
  });

  afterEach(() => {
    dataManager.callAction = callAction;
  });

  it('should order flow.stream items by timestamp when loading history', async () => {
    // Create flow mock
    const flowMock = new FlowMock({ id: '550e8400-e29b-41d4-a716-446655440099' });

    // Set mock history data from the backend response
    const historyData = [
      {
        content: '/shell echo hi ',
        timestamp: '2025-10-27T17:05:28.250229Z',
        role: 'user' as const,
        mode: null,
      },
      {
        content:
          '<flow-focus i="1378" t="2025-10-27T17:47:48.786751+00:00" data-type="string" previous-focus="chat">shell</flow-focus>\n' +
          '<flow-status i="1379" t="2025-10-27T17:47:48.786838+00:00" data-type="string">Executing shell command...</flow-status>\n' +
          '<flow-shell-input i="1380" t="2025-10-27T17:47:48.786919+00:00" focus="shell" data-type="string" workdir="~">echo hi</flow-shell-input>\n' +
          '<flow-shell-output i="1381" t="2025-10-27T17:47:48.787008+00:00" focus="shell" data-type="string" stream="stdout">hi\n</flow-shell-output>\n' +
          '<flow-focus i="1382" t="2025-10-27T17:47:48.787109+00:00" data-type="string" previous-focus="shell">chat</flow-focus>\n',
        timestamp: '2025-10-27T17:05:30.534465Z',
        role: 'assistant' as const,
      },
      {
        content: '/shell echo hi2',
        timestamp: '2025-10-27T17:33:13.522117Z',
        role: 'user' as const,
        mode: null,
      },
      {
        content:
          '<flow-focus i="1383" t="2025-10-27T17:47:48.787321+00:00" data-type="string" previous-focus="chat">shell</flow-focus>\n' +
          '<flow-status i="1384" t="2025-10-27T17:47:48.787394+00:00" data-type="string">Executing shell command...</flow-status>\n' +
          '<flow-shell-input i="1385" t="2025-10-27T17:47:48.787476+00:00" focus="shell" data-type="string" workdir="~">echo hi2</flow-shell-input>\n' +
          '<flow-shell-output i="1386" t="2025-10-27T17:47:48.787565+00:00" focus="shell" data-type="string" stream="stdout">hi2\n</flow-shell-output>\n' +
          '<flow-focus i="1387" t="2025-10-27T17:47:48.787665+00:00" data-type="string" previous-focus="shell">chat</flow-focus>\n',
        timestamp: '2025-10-27T17:33:16.388137Z',
        role: 'assistant' as const,
      },
    ];

    flowMock.setMockHistory(historyData);

    // Load history - this should process XML and populate flow.stream
    await flowMock.loadHistory();

    // Wait for stream processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log('\n=== Flow Stream Analysis ===');
    console.log('Total items in flow.stream:', flowMock.stream.items.length);

    // Print all items with their timestamps
    const items = flowMock.stream.items;
    items.forEach((item, index) => {
      console.log(`\nItem ${index}:`, {
        elementType: item.elementType,
        timestamp: item.timestamp,
        content: item.content?.substring(0, 50),
        attributes: item.attributes,
      });
    });

    // Extract shell-input and shell-output items
    const shellInputs = items.filter((item) => item.elementType === FlowElementTypes.SHELL_INPUT);
    const shellOutputs = items.filter((item) => item.elementType === FlowElementTypes.SHELL_OUTPUT);

    console.log('\n=== Shell Commands ===');
    console.log('Shell inputs:', shellInputs.length);
    console.log('Shell outputs:', shellOutputs.length);

    shellInputs.forEach((input, index) => {
      console.log(`\nShell Input ${index + 1}:`, {
        command: input.content,
        timestamp: input.timestamp,
        timestampMs: new Date(input.timestamp).getTime(),
      });
    });

    shellOutputs.forEach((output, index) => {
      console.log(`\nShell Output ${index + 1}:`, {
        content: output.content,
        timestamp: output.timestamp,
        timestampMs: new Date(output.timestamp).getTime(),
      });
    });

    // Validate chronological order
    console.log('\n=== Validating Chronological Order ===');

    for (let i = 1; i < items.length; i++) {
      const prevTime = new Date(items[i - 1].timestamp).getTime();
      const currTime = new Date(items[i].timestamp).getTime();

      console.log(`Item ${i - 1} -> Item ${i}:`, {
        prevTimestamp: items[i - 1].timestamp,
        currTimestamp: items[i].timestamp,
        prevTime,
        currTime,
        isOrdered: prevTime <= currTime,
        diff: currTime - prevTime,
      });

      if (prevTime > currTime) {
        console.error('❌ ORDER VIOLATION:', {
          prevItem: {
            index: i - 1,
            type: items[i - 1].elementType,
            timestamp: items[i - 1].timestamp,
          },
          currItem: {
            index: i,
            type: items[i].elementType,
            timestamp: items[i].timestamp,
          },
        });
      }
    }

    // Expected: All items should be in chronological order
    expect(items.length).toBeGreaterThan(0);

    // Verify chronological ordering
    for (let i = 1; i < items.length; i++) {
      const prevTime = new Date(items[i - 1].timestamp).getTime();
      const currTime = new Date(items[i].timestamp).getTime();

      expect(prevTime).toBeLessThanOrEqual(currTime);
    }

    // Verify we have shell commands
    expect(shellInputs.length).toBe(2);
    expect(shellOutputs.length).toBe(2);

    // Verify shell command content
    expect(shellInputs[0].content).toBe('echo hi');
    expect(shellInputs[1].content).toBe('echo hi2');
    expect(shellOutputs[0].content).toBe('hi\n');
    expect(shellOutputs[1].content).toBe('hi2\n');
  });
});
