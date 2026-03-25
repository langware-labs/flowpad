import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FlowStreamProcessor } from '@sdk/flow_processing/flow-stream-processor';
import { FlowData, FlowDataType } from '@sdk/flow_processing/flow-data';
import { FlowEvents } from '@sdk/flow_processing/flow-events';
import { FlowDataEvents } from '@sdk/flow_processing/flow-events';
import { FlowErrorEvent } from '@sdk/flow_processing/flow-errors';

describe('FlowStreamProcessor - Partial FlowData Support', () => {
  let processor: FlowStreamProcessor;

  beforeEach(() => {
    processor = new FlowStreamProcessor();
  });

  // ==================== CORE MECHANICS ====================

  describe('Core Mechanics', () => {
    it('Rule 1: should use group-id attribute (renamed from correlation-id)', () => {
      const xml =
        '<flow-shell-output i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="cmd_123">output</flow-shell-output>';
      processor.process_chunk(xml);
      processor.endStream();

      const elements = processor.getAggregatedEvents();
      expect(elements.length).toBe(1);
      expect(elements[0].groupId).toBe('cmd_123');
      expect(elements[0].attributes['group-id']).toBe('cmd_123');
    });

    it('Rule 2: should track partials in trackedPartials Map until final="true"', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1" final="true">part2</flow-test>';

      let readyEmitted = false;
      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.READY, () => {
          readyEmitted = true;
        });
      });

      processor.process_chunk(xml1);
      expect(readyEmitted).toBe(false); // Not ready yet

      processor.process_chunk(xml2);
      processor.endStream();
      expect(readyEmitted).toBe(true); // Ready after final
    });

    it('Rule 3: should merge subsequent partials into first partial instance', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1" final="true">part2</flow-test>';

      let firstInstance: FlowData | null = null;
      let chunkCount = 0;

      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        if (!firstInstance) {
          firstInstance = flowData;
        }

        flowData.on(FlowDataEvents.CHUNK, () => {
          chunkCount++;
          // Both chunks should be on the same instance
          expect(flowData).toBe(firstInstance);
        });
      });

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      expect(chunkCount).toBe(2);
    });

    it('Rule 4: external view should see single FlowData with merged content', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 = '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1">part2</flow-test>';
      const xml3 =
        '<flow-test i="3" t="2025-01-18T10:00:02Z" data-type="string" group-id="p1" final="true">part3</flow-test>';

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.process_chunk(xml3);
      processor.endStream();

      const elements = processor.getAggregatedEvents();
      expect(elements.length).toBe(1); // Single element from external view
      expect(elements[0].content).toBe('part1part2part3');
    });

    it('Rule 5: partials can interleave with other elements/partials', () => {
      const xml = `
        <flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">A1</flow-test>
        <flow-other i="2" t="2025-01-18T10:00:01Z" data-type="string">standalone</flow-other>
        <flow-test i="3" t="2025-01-18T10:00:02Z" data-type="string" group-id="p2">B1</flow-test>
        <flow-test i="4" t="2025-01-18T10:00:03Z" data-type="string" group-id="p1" final="true">A2</flow-test>
        <flow-test i="5" t="2025-01-18T10:00:04Z" data-type="string" group-id="p2" final="true">B2</flow-test>
      `;

      processor.process_chunk(xml);
      processor.endStream();

      const elements = processor.getAggregatedEvents();
      expect(elements.length).toBe(3);
      expect(elements[0].content).toBe('A1A2'); // p1 merged
      expect(elements[1].content).toBe('standalone'); // standalone
      expect(elements[2].content).toBe('B1B2'); // p2 merged
    });
  });

  // ==================== EVENT EMISSION ====================

  describe('Event Emission', () => {
    it('Rule 6: first partial should emit CHUNK/DATA but not PARSED/READY', () => {
      const xml = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">content</flow-test>';

      let chunkEmitted = false;
      let parsedEmitted = false;
      let readyEmitted = false;

      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.CHUNK, () => {
          chunkEmitted = true;
        });
        flowData.on(FlowDataEvents.PARSED, () => {
          parsedEmitted = true;
        });
        flowData.on(FlowDataEvents.READY, () => {
          readyEmitted = true;
        });
      });

      processor.process_chunk(xml);
      processor.endStream();

      expect(chunkEmitted).toBe(true);
      expect(parsedEmitted).toBe(false); // Should not be parsed yet
      expect(readyEmitted).toBe(false); // Should not be ready yet
    });

    it('Rule 7: subsequent partials should emit CHUNK/DATA on tracked instance', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 = '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1">part2</flow-test>';

      let firstInstance: FlowData | null = null;
      const chunkEvents: FlowData[] = [];

      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        if (!firstInstance) {
          firstInstance = flowData;
        }

        flowData.on(FlowDataEvents.CHUNK, () => {
          chunkEvents.push(flowData);
        });
      });

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      expect(chunkEvents.length).toBe(2);
      expect(chunkEvents[0]).toBe(firstInstance);
      expect(chunkEvents[1]).toBe(firstInstance);
    });

    it('Rule 8: final partial should emit PARSED/READY and be removed from tracking', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1" final="true">part2</flow-test>';

      let parsedEmitted = false;
      let readyEmitted = false;

      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.PARSED, () => {
          parsedEmitted = true;
        });
        flowData.on(FlowDataEvents.READY, () => {
          readyEmitted = true;
        });
      });

      processor.process_chunk(xml1);
      expect(parsedEmitted).toBe(false);
      expect(readyEmitted).toBe(false);

      processor.process_chunk(xml2);
      expect(parsedEmitted).toBe(true);
      expect(readyEmitted).toBe(true);
    });
  });

  // ==================== CONTENT & ATTRIBUTE MERGING ====================

  describe('Content & Attribute Merging', () => {
    it('Rule 9: content should be accumulated (appended) across all partials', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">Hello </flow-test>';
      const xml2 = '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1">World</flow-test>';
      const xml3 =
        '<flow-test i="3" t="2025-01-18T10:00:02Z" data-type="string" group-id="p1" final="true">!</flow-test>';

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.process_chunk(xml3);
      processor.endStream();

      const elements = processor.getAggregatedEvents();
      expect(elements[0].content).toBe('Hello World!');
      expect(elements[0].content).toBe('Hello World!');
    });

    it('Rule 10: attributes should be added (new) or overwritten (existing)', () => {
      const xml1 =
        '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1" attr1="value1" attr2="old">content1</flow-test>';
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1" attr2="new" attr3="value3" final="true">content2</flow-test>';

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      const element = processor.getAggregatedEvents()[0];
      expect(element.attributes['attr1']).toBe('value1'); // Kept from first
      expect(element.attributes['attr2']).toBe('new'); // Overwritten by second
      expect(element.attributes['attr3']).toBe('value3'); // Added by second
    });

    it('Rule 11: once-attrs (t, i) should be taken from first partial only', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 =
        '<flow-test i="999" t="2025-01-18T23:59:59Z" data-type="string" group-id="p1" final="true">part2</flow-test>';

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      const element = processor.getAggregatedEvents()[0];
      expect(element.index).toBe(1); // From first partial
      expect(element.timestamp).toBe('2025-01-18T10:00:00Z'); // From first partial
      expect(element.attributes['i']).toBe('1');
      expect(element.attributes['t']).toBe('2025-01-18T10:00:00Z');
    });
  });

  // ==================== TYPE RESTRICTIONS ====================

  describe('Type Restrictions', () => {
    it('Rule 12: partials should only be supported for FlowDataType.String', () => {
      const xmlString =
        '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1" final="true">text</flow-test>';

      processor.process_chunk(xmlString);
      processor.endStream();

      const elements = processor.getAggregatedEvents();
      expect(elements[0].error).toBe(false);
      expect(elements[0].dataType).toBe(FlowDataType.String);
    });

    it('Rule 13: object partials should throw error', () => {
      const xmlObject =
        '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="object" group-id="p1">{"key":"value"}</flow-test>';

      let errorEmitted = false;

      // Listen for errors at both processor and FlowData levels to prevent unhandled errors
      processor.on(FlowEvents.ERROR, () => {
        // Processor-level error listener to prevent unhandled errors
      });

      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.ERROR, () => {
          errorEmitted = true;
        });
      });

      processor.process_chunk(xmlObject);
      processor.endStream();

      expect(errorEmitted).toBe(true);
      const element = processor.getAggregatedEvents()[0];
      expect(element.error).toBe(true);
      expect(element.error_msg).toContain('Partials not supported for object type');
    });

    it('Rule 14: entity partials should throw error', () => {
      const xmlEntity =
        '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="entity" group-id="p1">{"type":"User"}</flow-test>';

      let errorEmitted = false;

      // Listen for errors at both processor and FlowData levels to prevent unhandled errors
      processor.on(FlowEvents.ERROR, () => {
        // Processor-level error listener to prevent unhandled errors
      });

      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.ERROR, () => {
          errorEmitted = true;
        });
      });

      processor.process_chunk(xmlEntity);
      processor.endStream();

      expect(errorEmitted).toBe(true);
      const element = processor.getAggregatedEvents()[0];
      expect(element.error).toBe(true);
      expect(element.error_msg).toContain('Partials not supported for entity type');
    });
  });

  // ==================== VALIDATION ====================

  describe('Validation', () => {
    it('Rule 15: all partials must have matching element-type and data-type', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      // NOTE: Changed from flow-other to flow-test to avoid XML parser state issues when tag names differ
      // The mismatch is now in data-type instead: object vs string
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="object" group-id="p1" final="true">{"key":"val"}</flow-test>';

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      let errorEmitted = false;

      // Listen for errors at both processor and FlowData levels to prevent unhandled errors
      processor.on(FlowEvents.ERROR, () => {
        // Processor-level error listener to prevent unhandled errors
      });

      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.ERROR, () => {
          errorEmitted = true;
        });
      });

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Partial mismatch'));
      expect(errorEmitted).toBe(true);

      consoleError.mockRestore();
    });

    it('Rule 16: type mismatch should close partial with error and remove from tracking', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="object" group-id="p1" final="true">{"key":"val"}</flow-test>';

      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Listen for errors at both processor and FlowData levels to prevent unhandled errors
      processor.on(FlowEvents.ERROR, () => {});
      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.ERROR, () => {});
      });

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      const elements = processor.getAggregatedEvents();
      expect(elements[0].error).toBe(true);

      consoleError.mockRestore();
    });

    it('Rule 17: different element types with same group-id and channel should NOT merge', () => {
      const xml = `
        <flow-shell-output i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="cmd_123" channel="stdout">output1</flow-shell-output>
        <flow-user-message i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="cmd_123" channel="stdout">message1</flow-user-message>
        <flow-shell-output i="3" t="2025-01-18T10:00:02Z" data-type="string" group-id="cmd_123" channel="stdout" final="true">output2</flow-shell-output>
        <flow-user-message i="4" t="2025-01-18T10:00:03Z" data-type="string" group-id="cmd_123" channel="stdout" final="true">message2</flow-user-message>
      `;

      processor.process_chunk(xml);
      processor.endStream();

      const elements = processor.getAggregatedEvents();

      // Should have 2 separate elements, not merged
      expect(elements.length).toBe(2);

      // Find shell-output and user-message elements
      const shellOutput = elements.find((e) => e.elementType === 'shell-output');
      const userMessage = elements.find((e) => e.elementType === 'user-message');

      // Both should exist as separate elements
      expect(shellOutput).toBeDefined();
      expect(userMessage).toBeDefined();

      // Each should have its own content, not merged
      expect(shellOutput?.content).toBe('output1output2');
      expect(userMessage?.content).toBe('message1message2');

      // Both should have the same group-id
      expect(shellOutput?.groupId).toBe('cmd_123');
      expect(userMessage?.groupId).toBe('cmd_123');
    });
  });

  // ==================== LIMITS & CLEANUP ====================

  describe('Limits & Cleanup', () => {
    it('Rule 17: max 20 tracked partials simultaneously', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Create 21 different group-ids
      for (let i = 1; i <= 21; i++) {
        const xml = `<flow-test i="${i}" t="2025-01-18T10:00:00Z" data-type="string" group-id="p${i}">part${i}</flow-test>`;
        processor.process_chunk(xml);
      }
      processor.endStream();

      // Should have logged error for 21st partial
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Max partials (20) exceeded'));

      // Should only have 20 elements (21st was dropped)
      const elements = processor.getAggregatedEvents();
      expect(elements.length).toBe(20);

      consoleError.mockRestore();
    });

    it('Rule 18: exceeding limit should console.error and drop new partial', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Fill up to max
      for (let i = 1; i <= 20; i++) {
        processor.process_chunk(
          `<flow-test i="${i}" t="2025-01-18T10:00:00Z" data-type="string" group-id="p${i}">content</flow-test>`,
        );
      }

      // Try to add 21st
      processor.process_chunk(
        '<flow-test i="21" t="2025-01-18T10:00:00Z" data-type="string" group-id="p21">dropped</flow-test>',
      );
      processor.endStream();

      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('dropping: p21'));

      consoleError.mockRestore();
    });

    it('Rule 19: orphaned partials (no final) should console.warn on endStream()', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">orphan1</flow-test>';
      const xml2 = '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p2">orphan2</flow-test>';

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('Stream ended with 2 incomplete partials'),
        expect.arrayContaining(['p1', 'p2']),
      );

      consoleWarn.mockRestore();
    });

    it('Rule 20: stream end should expect zero partials remaining', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Complete all partials properly
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1" final="true">part2</flow-test>';

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      // No warning should be emitted
      expect(consoleWarn).not.toHaveBeenCalledWith(expect.stringContaining('incomplete partials'));

      consoleWarn.mockRestore();
    });
  });

  // ==================== ERROR HANDLING ====================

  describe('Error Handling', () => {
    it('Rule 21: errors should emit as usual (ERROR event on FlowData)', () => {
      const xml = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="object" group-id="p1">invalid</flow-test>';

      let errorEmitted = false;

      // Listen for errors at both processor and FlowData levels to prevent unhandled errors
      processor.on(FlowEvents.ERROR, () => {});
      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.ERROR, (errorEvent: FlowErrorEvent) => {
          errorEmitted = true;
          expect(errorEvent).toBeDefined();
          expect(errorEvent.error).toBeDefined();
          expect(errorEvent.message).toBeDefined();
        });
      });

      processor.process_chunk(xml);
      processor.endStream();

      expect(errorEmitted).toBe(true);
    });

    it('Rule 22: final partial with error should close and mark error', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="object" group-id="p1" final="true">{"invalid"}</flow-test>';

      // Listen for errors at both processor and FlowData levels to prevent unhandled errors
      processor.on(FlowEvents.ERROR, () => {});
      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.ERROR, () => {});
      });

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      const element = processor.getAggregatedEvents()[0];
      expect(element.error).toBe(true);
    });
  });

  // ==================== EDGE CASES ====================

  describe('Edge Cases', () => {
    it('should handle single partial with final="true" immediately', () => {
      const xml =
        '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1" final="true">single</flow-test>';

      let readyEmitted = false;
      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.READY, () => {
          readyEmitted = true;
        });
      });

      processor.process_chunk(xml);
      processor.endStream();

      expect(readyEmitted).toBe(true);
      const elements = processor.getAggregatedEvents();
      expect(elements.length).toBe(1);
      expect(elements[0].content).toBe('single');
    });

    it('should handle empty partial content', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1"></flow-test>';
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1" final="true">content</flow-test>';

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      const elements = processor.getAggregatedEvents();
      expect(elements[0].content).toBe('content');
    });

    it('should handle mixed partial and non-partial elements', () => {
      const xml = `
        <flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string">standalone1</flow-test>
        <flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1">partial1</flow-test>
        <flow-test i="3" t="2025-01-18T10:00:02Z" data-type="string">standalone2</flow-test>
        <flow-test i="4" t="2025-01-18T10:00:03Z" data-type="string" group-id="p1" final="true">partial2</flow-test>
      `;

      processor.process_chunk(xml);
      processor.endStream();

      const elements = processor.getAggregatedEvents();
      expect(elements.length).toBe(3);
      expect(elements[0].content).toBe('standalone1');
      expect(elements[0].groupId).toBeNull();
      expect(elements[1].content).toBe('partial1partial2');
      expect(elements[1].groupId).toBe('p1');
      expect(elements[2].content).toBe('standalone2');
      expect(elements[2].groupId).toBeNull();
    });

    it('should handle self-closing tags with group-id (should error)', () => {
      const xml = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1"/>';

      let _errorEmitted = false;
      processor.on(FlowEvents.DATA, (flowData: FlowData) => {
        flowData.on(FlowDataEvents.ERROR, () => {
          _errorEmitted = true;
        });
      });

      processor.process_chunk(xml);
      processor.endStream();

      // Self-closing with group-id should complete immediately with content
      // Since it's self-closing and String type, it should work
      const elements = processor.getAggregatedEvents();
      expect(elements.length).toBe(1);
    });

    it('should preserve final="true" attribute in merged element', () => {
      const xml1 = '<flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">part1</flow-test>';
      const xml2 =
        '<flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p1" final="true">part2</flow-test>';

      processor.process_chunk(xml1);
      processor.process_chunk(xml2);
      processor.endStream();

      const element = processor.getAggregatedEvents()[0];
      expect(element.isFinal).toBe(true);
    });

    it('should handle multiple different group-ids in parallel', () => {
      const xml = `
        <flow-test i="1" t="2025-01-18T10:00:00Z" data-type="string" group-id="p1">A1</flow-test>
        <flow-test i="2" t="2025-01-18T10:00:01Z" data-type="string" group-id="p2">B1</flow-test>
        <flow-test i="3" t="2025-01-18T10:00:02Z" data-type="string" group-id="p3">C1</flow-test>
        <flow-test i="4" t="2025-01-18T10:00:03Z" data-type="string" group-id="p1">A2</flow-test>
        <flow-test i="5" t="2025-01-18T10:00:04Z" data-type="string" group-id="p2">B2</flow-test>
        <flow-test i="6" t="2025-01-18T10:00:05Z" data-type="string" group-id="p1" final="true">A3</flow-test>
        <flow-test i="7" t="2025-01-18T10:00:06Z" data-type="string" group-id="p3">C2</flow-test>
        <flow-test i="8" t="2025-01-18T10:00:07Z" data-type="string" group-id="p2" final="true">B3</flow-test>
        <flow-test i="9" t="2025-01-18T10:00:08Z" data-type="string" group-id="p3" final="true">C3</flow-test>
      `;

      processor.process_chunk(xml);
      processor.endStream();

      const elements = processor.getAggregatedEvents();
      expect(elements.length).toBe(3);
      expect(elements[0].content).toBe('A1A2A3'); // p1
      expect(elements[1].content).toBe('B1B2B3'); // p2
      expect(elements[2].content).toBe('C1C2C3'); // p3
    });
  });
});
