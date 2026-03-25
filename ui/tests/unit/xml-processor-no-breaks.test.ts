import { describe, expect, it } from 'vitest';
import { FlowStreamProcessor, FlowData, FlowEvents } from '@sdk';

describe('FlowStreamProcessor - No Line Breaks XML', () => {
  it('should process XML without line breaks correctly', () => {
    const processor = new FlowStreamProcessor();
    const elements: FlowData[] = [];

    // Listen for DATA events and wait for READY on each element
    processor.on(FlowEvents.DATA, (flowData: FlowData) => {
      flowData.on('ready', () => {
        elements.push(flowData);
      });
    });

    // XML string - elements separated by space (testing no line breaks)
    // Use simple text elements instead of JSON to test streaming accumulation
    const xml =
      '<flow-text i="274" t="2025-11-04T16:19:37.364657+00:00" data-type="string">Hello World</flow-text> <flow-text i="275" t="2025-11-04T16:19:37.366119+00:00" data-type="string">Second Message</flow-text>';

    // Process the XML
    processor.process_chunk(xml);
    processor.endStream();

    // Assertions
    expect(elements.length).toBe(2);

    // First element: flow-text
    expect(elements[0].elementType).toBe('text');
    expect(elements[0].content).toBe('Hello World');
    expect(elements[0].attributes['i']).toBe('274');

    // Second element: flow-text
    expect(elements[1].elementType).toBe('text');
    expect(elements[1].content).toBe('Second Message');
    expect(elements[1].attributes['i']).toBe('275');
  });
});
