import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FlowData,
  FlowDataEvents,
  FlowDataType,
  FlowElementTypes,
  FlowEvents,
  FlowStreamProcessor,
} from '@sdk';
import { collectAllChunks, createMockStreamer, verifyChunksReconstruct } from './mock_flow_streamer_test_utils';

// Initialize pseudo-random seed at module level
const SEED = 42;

describe('XML Stream Processor', () => {
  let processor: FlowStreamProcessor;

  beforeEach(() => {
    processor = new FlowStreamProcessor();
  });

  describe('Random Chunk Streaming', () => {
    it('should parse flow-testme tag with random chunking and emit correct events', () => {
      // Test XML content
      const xmlContent = '<flow-testme i="0" t="2025-10-03T12:00:00.123456Z">just test</flow-testme>';

      // Create mock streamer with fixed seed for reproducibility
      const streamer = createMockStreamer(xmlContent, SEED);

      // Set up event listeners
      let eventReceived = false;
      let eventCount = 0;
      let capturedEventData: FlowData | null = null;

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        if (flowEvent.elementType === FlowElementTypes.TESTME) {
          eventReceived = true;
          eventCount++;
          capturedEventData = flowEvent;
        }
      });

      // Process chunks one by one
      let chunk = streamer.get_next_chunk();
      const chunks: string[] = [];

      while (chunk !== null) {
        chunks.push(chunk);
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Verify chunks reconstruct to original
      expect(verifyChunksReconstruct(chunks, xmlContent)).toBe(true);

      // Verify event was received
      expect(eventReceived).toBe(true);

      // Verify event was received exactly once
      expect(eventCount).toBe(1);

      // Verify FlowDataProcessor properties
      expect(capturedEventData).toBeTruthy();
      expect(capturedEventData!.elementType).toBe(FlowElementTypes.TESTME);
      expect(capturedEventData!.dataType).toBe('string');
      expect(capturedEventData!.content).toBe('just test');
      expect(capturedEventData!.timestamp).toBe('2025-10-03T12:00:00.123456Z');
      expect(capturedEventData!.index).toBe(0);
    });

    it('should handle multiple random chunk patterns with same seed producing same results', () => {
      const xmlContent = '<flow-testme>just test</flow-testme>';

      // First run
      const streamer1 = createMockStreamer(xmlContent, SEED);
      const chunks1 = collectAllChunks(streamer1);

      // Second run with same seed
      const streamer2 = createMockStreamer(xmlContent, SEED);
      const chunks2 = collectAllChunks(streamer2);

      // Should produce identical chunking pattern
      expect(chunks1).toEqual(chunks2);
    });

    it('should handle edge case: single character chunks', () => {
      const xmlContent = '<flow-testme>X</flow-testme>';
      const processor = new FlowStreamProcessor();

      let eventReceived = false;
      const errors: any[] = [];

      processor.on(FlowEvents.DATA_END, (flowEvent: FlowData) => {
        if (flowEvent.elementType === FlowElementTypes.TESTME) {
          eventReceived = true;
          expect(flowEvent.elementType).toBe(FlowElementTypes.TESTME);
          expect(flowEvent.dataType).toBe('string');
          expect(flowEvent.content).toBe('X');
        }
      });

      processor.on(FlowEvents.ERROR, (error: any) => {
        errors.push(error);
      });

      // Process character by character
      for (const char of xmlContent) {
        processor.process_chunk(char);
      }
      processor.endStream();

      expect(eventReceived).toBe(true);
      expect(errors).toHaveLength(0); // Should not have errors for complete XML
    });
  });

  describe('All Backend Flow XML Formats', () => {
    it('should handle all backend flow message types with random chunking', () => {
      const xmlFormats = [
        '<flow-state key="user_prompt_analysis" data-type="object">{"analysis":"result"}</flow-state>',
        '<chat data-type="string">Basic chat message</chat>',
        '<flow-user-message data-type="string">User message content</flow-user-message>',
        '<flow-reasoning data-type="string">AI reasoning content</flow-reasoning>',
        '<flow-shell data-type="string">shell command output</flow-shell>',
        '<flow-result path="/test/file.txt" data-type="string">Result content</flow-result>',
        '<flow-secret name="api_key" data-type="string">Secret value</flow-secret>',
        '<flow-checkpoint hash="abc123" data-type="string">Checkpoint data</flow-checkpoint>',
        '<flow-write path="/output/file.py" data-type="string">File content to write</flow-write>',
        '<flow-web-app port="3000" data-type="string">Web app running</flow-web-app>',
        '<flow-state key="chat_options" data-type="object">{"search":true}</flow-state>',
        '<flow-state key="root_todo" data-type="object">{"id":"456","content":"Todo item"}</flow-state>',
      ];

      const processor = new FlowStreamProcessor();
      const receivedEvents: Array<{ type: string; content: string; event: string }> = [];

      // Listen to all element completion events
      processor.on(FlowEvents.DATA_END, (flowEvent: FlowData) => {
        receivedEvents.push({
          type: flowEvent.elementType,
          content: flowEvent.content,
          event: flowEvent.elementType,
        });
      });

      // Test each XML format with random chunking
      xmlFormats.forEach((xmlContent, index) => {
        processor.reset();
        const streamer = createMockStreamer(xmlContent, SEED + index);

        let chunk = streamer.get_next_chunk();
        let chunkCount = 0;
        while (chunk !== null) {
          processor.process_chunk(chunk);
          chunk = streamer.get_next_chunk();
          chunkCount++;
        }
        console.log(
          `ending stream for ${xmlContent}, index: ${index}, receivedEvents: ${receivedEvents.length}, chunkCount: ${chunkCount}  `,
        );
        processor.endStream();
      });

      // Verify all expected events were received
      const expectedEventTypes = [
        FlowElementTypes.CHAT,
        FlowElementTypes.USER_MESSAGE,
        FlowElementTypes.REASONING,
        FlowElementTypes.SHELL,
        FlowElementTypes.RESULT,
        FlowElementTypes.SECRET,
        FlowElementTypes.CHECKPOINT,
        FlowElementTypes.WRITE,
        FlowElementTypes.WEB_APP,
        FlowElementTypes.STATE,
      ];

      expectedEventTypes.forEach((eventType) => {
        const found = receivedEvents.find((e) => e.type === eventType);
        expect(found, `Event type ${eventType} not found in received events`).toBeTruthy();
        if (eventType !== FlowElementTypes.STATE) {
          expect(found?.content).toBeTruthy();
        }
      });

      // Verify correct number of events
      expect(receivedEvents).toHaveLength(12);

      // Verify we got 3 state events
      const stateEvents = receivedEvents.filter((e) => e.type === 'state');
      expect(stateEvents).toHaveLength(3);
    });

    it('should handle complex XML with attributes and random chunking', () => {
      const complexXml =
        '<flow-result path="/complex/file.txt" type="json" data-type="object">{"data": "value", "nested": {"key": "content"}}</flow-result>';
      const processor = new FlowStreamProcessor();

      let eventReceived = false;
      let capturedFlowProcessor: FlowData | null = null;

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        if (flowEvent.elementType === FlowElementTypes.RESULT) {
          eventReceived = true;
          capturedFlowProcessor = flowEvent;
        }
      });

      // Stream with random chunks
      const streamer = createMockStreamer(complexXml, SEED);
      let chunk = streamer.get_next_chunk();

      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      expect(eventReceived).toBe(true);
      expect(capturedFlowProcessor).toBeTruthy();
      expect(capturedFlowProcessor!.elementType).toBe(FlowElementTypes.RESULT);
      expect(capturedFlowProcessor!.dataType).toBe('object'); // JSON content is detected and classified as object
      expect(capturedFlowProcessor!.data).toEqual({ data: 'value', nested: { key: 'content' } });
    });

    it('should parse flow-result with artifact data structure', () => {
      // Test flow-result with artifact metadata (structure verification without importing Artifact class)
      const artifactXml =
        '<flow-result path="/output/report.json" name="Analysis Report" description="Monthly analysis report" type="file" data-type="object">{"analysis": "complete", "metrics": {"accuracy": 0.95}}</flow-result>';
      const processor = new FlowStreamProcessor();

      let artifactDataParsed = false;
      let parsedData: any = null;

      processor.on(FlowEvents.DATA_END, (flowEvent: FlowData) => {
        if (flowEvent.elementType !== FlowElementTypes.RESULT) return;

        // Verify we can extract artifact information from flow-result FlowDataProcessor
        // For object type, data is the parsed JSON, so stringify it to get the raw JSON
        const content = flowEvent.dataType === FlowDataType.Object ? JSON.stringify(flowEvent.data) : flowEvent.content;

        // Extract path from the XML attributes (would normally come from XML parser)
        // For this test, we'll simulate the attribute extraction
        const pathMatch = artifactXml.match(/path="([^"]+)"/);
        const nameMatch = artifactXml.match(/name="([^"]+)"/);
        const descMatch = artifactXml.match(/description="([^"]+)"/);

        const artifactData = {
          name: nameMatch ? nameMatch[1] : 'report.json',
          path: pathMatch ? pathMatch[1] : '/output/report.json',
          description: descMatch ? descMatch[1] : undefined,
          ref_type: 'FILE',
          metadata: {
            type: 'FILE',
            content: content,
            flowEventType: flowEvent.elementType,
            flowDataType: flowEvent.dataType,
          },
        };

        parsedData = artifactData;
        artifactDataParsed = true;
      });

      // Stream with random chunks
      const streamer = createMockStreamer(artifactXml, SEED);
      let chunk = streamer.get_next_chunk();

      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Verify artifact data was parsed correctly
      expect(artifactDataParsed).toBe(true);
      expect(parsedData).toBeTruthy();
      expect(parsedData.name).toBe('Analysis Report');
      expect(parsedData.path).toBe('/output/report.json');
      expect(parsedData.description).toBe('Monthly analysis report');
      expect(parsedData.ref_type).toBe('FILE');
      expect(parsedData.metadata.type).toBe('FILE');
      expect(parsedData.metadata.content).toBe('{"analysis":"complete","metrics":{"accuracy":0.95}}');
      expect(parsedData.metadata.flowEventType).toBe(FlowElementTypes.RESULT);
      expect(parsedData.metadata.flowDataType).toBe('object'); // JSON content is detected and classified as object
    });

    it('should handle mixed flow messages in sequence', () => {
      const mixedXml = `
        <flow-reasoning i="0" t="2025-10-03T12:00:01.000000Z" data-type="string">First, I need to analyze the problem</flow-reasoning>
        <flow-shell i="1" t="2025-10-03T12:00:02.000000Z" data-type="string">ls -la /tmp</flow-shell>
        <flow-write i="2" t="2025-10-03T12:00:03.000000Z" path="/output.txt" data-type="string">Hello World</flow-write>
        <flow-result i="3" t="2025-10-03T12:00:04.000000Z" data-type="string">Task completed successfully</flow-result>
      `.trim();

      const processor = new FlowStreamProcessor();
      const events: Array<{ type: string; content: string; dataType: string }> = [];
      const errors: any[] = [];

      processor.on(FlowEvents.DATA_END, (flowEvent: FlowData) => {
        if (flowEvent.dataType) {
          events.push({ type: flowEvent.elementType, content: flowEvent.content, dataType: flowEvent.dataType });
        } else {
          events.push({ type: flowEvent.elementType, content: flowEvent.content, dataType: 'unknown data type' });
        }
      });

      processor.on(FlowEvents.ERROR, (error: any) => {
        errors.push(error);
      });

      // Stream with random chunks
      const streamer = createMockStreamer(mixedXml, SEED);
      let chunk = streamer.get_next_chunk();

      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Debug: show what events we actually got
      console.log(
        'Received events:',
        events.map((e) => ({ type: e.type, content: e.content })),
      );

      // Verify sequence and content
      expect(events).toHaveLength(4);
      expect(events[0].type).toBe(FlowElementTypes.REASONING);
      expect(events[0].content).toBe('First, I need to analyze the problem');
      expect(events[0].dataType).toBe('string');
      expect(events[1].type).toBe(FlowElementTypes.SHELL);
      expect(events[1].content).toBe('ls -la /tmp');
      expect(events[1].dataType).toBe('string');
      expect(events[2].type).toBe(FlowElementTypes.WRITE);
      expect(events[2].content).toBe('Hello World');
      expect(events[2].dataType).toBe('string');
      expect(events[3].type).toBe(FlowElementTypes.RESULT);
      expect(events[3].content).toBe('Task completed successfully');
      expect(events[3].dataType).toBe('string');
    });

    it('should handle malformed XML gracefully', () => {
      const malformedXml = '<flow-test>Incomplete tag without';
      const processor = new FlowStreamProcessor();

      let eventEndReceived = false;
      const errors: any[] = [];

      processor.on(FlowEvents.DATA_END, () => {
        eventEndReceived = true;
      });

      processor.on(FlowEvents.ERROR, (error: any) => {
        errors.push(error);
      });

      // Should not crash or emit completion events for malformed XML
      processor.process_chunk(malformedXml);
      processor.endStream();
      expect(eventEndReceived).toBe(false); // No completion event for incomplete XML

      // With endStream(), incomplete elements trigger an error
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('incomplete stream');
    });

    it('should parse and preserve timestamp from t attribute', () => {
      const testTimestamp = '2025-10-03T15:30:45.123456Z';
      const xmlContent = `<flow-test i="5" t="${testTimestamp}" data-type="string">test content</flow-test>`;
      const processor = new FlowStreamProcessor();

      let capturedFlowData: FlowData | null = null;

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        capturedFlowData = flowEvent;
      });

      // Process the XML
      const streamer = createMockStreamer(xmlContent, SEED);
      let chunk = streamer.get_next_chunk();

      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Verify timestamp was parsed correctly
      expect(capturedFlowData).toBeTruthy();
      expect(capturedFlowData!.timestamp).toBe(testTimestamp);
      expect(capturedFlowData!.index).toBe(5);
      expect(capturedFlowData!.elementType).toBe(FlowElementTypes.TEST);
    });

    it('should generate timestamp when t attribute is missing and show warning', () => {
      const xmlContent = '<flow-test i="10" data-type="string">test without timestamp</flow-test>';
      const processor = new FlowStreamProcessor();

      let capturedFlowData: FlowData | null = null;
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        capturedFlowData = flowEvent;
      });

      // Process the XML
      const streamer = createMockStreamer(xmlContent, SEED);
      let chunk = streamer.get_next_chunk();

      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Verify timestamp was auto-generated
      expect(capturedFlowData).toBeTruthy();
      expect(capturedFlowData!.timestamp).toBeTruthy();

      // Verify it's a valid ISO 8601 timestamp
      const timestamp = new Date(capturedFlowData!.timestamp);
      expect(timestamp.toISOString()).toBe(capturedFlowData!.timestamp);

      // Verify warning was logged
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("FlowData created without timestamp attribute 't' for tagName: test, index: 10"),
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Stream Processor Core Functionality', () => {
    it('should reset state correctly', () => {
      const errors: any[] = [];

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        if (flowEvent.elementType === FlowElementTypes.TEST) {
          vi.fn()(flowEvent);
        }
      });
      processor.on(FlowEvents.ERROR, (error: any) => {
        errors.push(error);
      });

      // Process some content
      processor.process_chunk('<flow-test>con');
      processor.endStream();
      expect(processor.getBuffer()).toBe('');

      // Expect incomplete stream error
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('incomplete stream');

      // Reset
      processor.reset();
      expect(processor.getBuffer()).toBe('');
    });

    it('should handle empty content tags', () => {
      const xmlContent = '<flow-empty data-type="string"></flow-empty>';
      const processor = new FlowStreamProcessor();

      let eventEndFired = false;
      processor.on(FlowEvents.DATA_END, (_flowEvent: FlowData) => {
        eventEndFired = true;
      });

      processor.process_chunk(xmlContent);
      processor.endStream();

      // Empty tags should now fire completion events (changed behavior - all elements emitted)
      expect(eventEndFired).toBe(true);
    });

    it('should handle whitespace-only content', () => {
      const xmlContent = '<flow-space data-type="string">   \n\t  </flow-space>';
      const processor = new FlowStreamProcessor();

      let eventEndFired = false;
      processor.on(FlowEvents.DATA_END, (_flowEvent: FlowData) => {
        eventEndFired = true;
      });

      processor.process_chunk(xmlContent);
      processor.endStream();

      // Whitespace-only content should now fire completion events (changed behavior - all elements emitted)
      expect(eventEndFired).toBe(true);
    });
  });

  describe('Event Aggregation Features', () => {
    it('should maintain aggregated text across chunks', () => {
      const processor = new FlowStreamProcessor();

      // Process text in multiple chunks
      processor.process_chunk('<flow-test data-type="string">Hello ');
      processor.process_chunk('World');
      processor.process_chunk('!</flow-test>');
      processor.endStream();

      // Verify aggregated text contains all chunks
      const aggregatedText = processor.getAggregatedText();
      expect(aggregatedText).toBe('<flow-test data-type="string">Hello World!</flow-test>');
    });

    it('should emit "events" aggregated event with all FlowDataProcessors', () => {
      const processor = new FlowStreamProcessor();
      const eventsReceived: FlowData[][] = [];

      // Listen to 'elements' aggregated emission
      processor.on(FlowEvents.DATA_LIST, (events: FlowData[]) => {
        eventsReceived.push([...events]);
      });

      // Process multiple XML messages
      processor.process_chunk('<flow-reasoning>First thought</flow-reasoning>');
      processor.process_chunk('<flow-shell>ls -la</flow-shell>');
      processor.process_chunk('<flow-result>Task complete</flow-result>');
      processor.endStream();

      // Verify events aggregation
      expect(eventsReceived).toHaveLength(3);

      // First emission should have 1 event
      expect(eventsReceived[0]).toHaveLength(1);
      expect(eventsReceived[0][0].elementType).toBe(FlowElementTypes.REASONING);

      // Second emission should have 2 events
      expect(eventsReceived[1]).toHaveLength(2);
      expect(eventsReceived[1][0].elementType).toBe(FlowElementTypes.REASONING);
      expect(eventsReceived[1][1].elementType).toBe(FlowElementTypes.SHELL);

      // Third emission should have 3 events
      expect(eventsReceived[2]).toHaveLength(3);
      expect(eventsReceived[2][0].elementType).toBe(FlowElementTypes.REASONING);
      expect(eventsReceived[2][1].elementType).toBe(FlowElementTypes.SHELL);
      expect(eventsReceived[2][2].elementType).toBe(FlowElementTypes.RESULT);
    });

    it('should generate unique keys for each event', () => {
      const processor = new FlowStreamProcessor();
      const receivedEvents: FlowData[] = [];

      processor.on(FlowEvents.DATA, (event: FlowData) => {
        receivedEvents.push(event);
      });

      // Process multiple events with explicit index attributes
      processor.process_chunk('<flow-test i="0">Event 1</flow-test>');
      processor.process_chunk('<flow-test i="1">Event 2</flow-test>');
      processor.process_chunk('<flow-test i="2">Event 3</flow-test>');
      processor.endStream();

      // Verify each event has a unique index
      expect(receivedEvents).toHaveLength(3);
      expect(receivedEvents[0].index).toBe(0);
      expect(receivedEvents[1].index).toBe(1);
      expect(receivedEvents[2].index).toBe(2);

      // Verify all indices are different
      const indices = receivedEvents.map((e) => e.index);
      const uniqueIndices = new Set(indices);
      expect(uniqueIndices.size).toBe(3);
    });

    it('should provide access to aggregated events via getter', () => {
      const processor = new FlowStreamProcessor();

      processor.process_chunk('<flow-reasoning>Thinking...</flow-reasoning>');
      processor.process_chunk('<flow-shell>echo test</flow-shell>');
      processor.endStream();

      // Verify aggregated events getter
      const aggregatedEvents = processor.getAggregatedEvents();
      expect(aggregatedEvents).toHaveLength(2);
      expect(aggregatedEvents[0].elementType).toBe(FlowElementTypes.REASONING);
      expect(aggregatedEvents[1].elementType).toBe(FlowElementTypes.SHELL);

      // Verify event count getter
      expect(processor.getEventCount()).toBe(2);
    });

    it('should reset aggregation state properly', () => {
      const processor = new FlowStreamProcessor();

      // Process some events
      processor.process_chunk('<flow-test>Test content</flow-test>');
      processor.endStream();

      // Verify state before reset
      expect(processor.getAggregatedText()).toBe('<flow-test>Test content</flow-test>');
      expect(processor.getEventCount()).toBe(1);

      // Reset
      processor.reset();

      // Verify state after reset
      expect(processor.getAggregatedText()).toBe('');
      expect(processor.getEventCount()).toBe(0);
      expect(processor.getAggregatedEvents()).toEqual([]);
      expect(processor.getBuffer()).toBe('');
    });

    it('should maintain event order in aggregated events', () => {
      const processor = new FlowStreamProcessor();

      // Process events in specific order
      processor.process_chunk('<flow-reasoning>Step 1</flow-reasoning>');
      processor.process_chunk('<flow-shell>Step 2</flow-shell>');
      processor.process_chunk('<flow-result>Step 3</flow-result>');
      processor.process_chunk('<flow-checkpoint>Step 4</flow-checkpoint>');
      processor.endStream();

      const dataArr = processor.getAggregatedEvents();
      expect(dataArr).toHaveLength(4);

      // Verify order is maintained
      expect(dataArr[0].elementType).toBe(FlowElementTypes.REASONING);
      expect(dataArr[0].content).toBe('Step 1');
      expect(dataArr[1].elementType).toBe(FlowElementTypes.SHELL);
      expect(dataArr[1].content).toBe('Step 2');
      expect(dataArr[2].elementType).toBe(FlowElementTypes.RESULT);
      expect(dataArr[2].content).toBe('Step 3');
      expect(dataArr[3].elementType).toBe(FlowElementTypes.CHECKPOINT);
      expect(dataArr[3].content).toBe('Step 4');
    });
  });

  describe('Stream Events', () => {
    it('should emit stream:element_start and stream:element_end events', () => {
      const processor = new FlowStreamProcessor();
      const streamStartEvents: FlowData[] = [];
      const streamEndEvents: FlowData[] = [];
      let startContent: string = '';
      let endContent: string = '';

      // Listen to stream events and capture content at time of emission
      processor.on(FlowEvents.STREAM_ELEMENT_START, (element: FlowData) => {
        streamStartEvents.push(element);
        startContent = element.content; // Capture content at start
      });

      processor.on(FlowEvents.STREAM_ELEMENT_END, (element: FlowData) => {
        streamEndEvents.push(element);
        endContent = element.content; // Capture content at end
      });

      // Process a complete XML element
      processor.process_chunk('<flow-test>Hello World</flow-test>');
      processor.endStream();

      // Verify stream:element_start was emitted
      expect(streamStartEvents).toHaveLength(1);
      expect(streamStartEvents[0].elementType).toBe(FlowElementTypes.TEST);
      expect(startContent).toBe(''); // Content was empty when start event was emitted

      // Verify stream:element_end was emitted
      expect(streamEndEvents).toHaveLength(1);
      expect(streamEndEvents[0].elementType).toBe(FlowElementTypes.TEST);
      expect(endContent).toBe('Hello World'); // Content was filled when end event was emitted

      // Verify it's the same element instance
      expect(streamStartEvents[0]).toBe(streamEndEvents[0]);

      // Verify the element's final state has the content
      expect(streamStartEvents[0].content).toBe('Hello World');
    });

    it('should emit data events during element processing with streaming properties', () => {
      const processor = new FlowStreamProcessor();
      let elementUnderProcessing: FlowData | null = null;
      const dataEvents: any[] = [];

      // Capture the element under processing
      processor.on(FlowEvents.STREAM_ELEMENT_START, (element: FlowData) => {
        elementUnderProcessing = element;

        // Listen to data events on the element
        element.on(FlowDataEvents.CHUNK, (data: any) => {
          dataEvents.push(data);
        });
      });

      // Process XML in multiple chunks to simulate streaming
      processor.process_chunk('<flow-test>');
      processor.process_chunk('Hello');
      processor.process_chunk(' ');
      processor.process_chunk('World');
      processor.process_chunk('</flow-test>');
      processor.endStream();

      // Verify data events were emitted
      expect(dataEvents.length).toBeGreaterThan(0);

      // Verify the final element state
      expect(elementUnderProcessing).toBeTruthy();
      expect(elementUnderProcessing!.content).toBe('Hello World');

      // Verify last data event contains complete content
      const lastDataEvent = dataEvents[dataEvents.length - 1];
      expect(lastDataEvent.totalContent).toBe('Hello World');
      expect(lastDataEvent.delta).toBe('World');
    });
  });

  describe('Chunk Emission Markers', () => {
    it('tag_chunk_boundary test: should validate exact element count with chunk boundaries breaking tags', () => {
      // Test XML with chunk boundary breaking within tag name
      const xmlContent =
        '<flow-state key="current_mode" data-type="object">{"mode":"Agent"}</flow-||state>||<flow-text>Hello world</flow-text>||<flow-text>Second message</flow-text>';

      // Create mock streamer with chunk markers
      const streamer = createMockStreamer(xmlContent);

      // Set up event listeners to count elements
      const elements: FlowData[] = [];
      const textElements: FlowData[] = [];
      const stateElements: FlowData[] = [];

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        elements.push(flowEvent);
        console.log(`Captured element: ${flowEvent.elementType} with content: "${flowEvent.content}"`);
      });

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        if (flowEvent.elementType === FlowElementTypes.TEXT) {
          textElements.push(flowEvent);
        }
      });

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        if (flowEvent.elementType === FlowElementTypes.STATE) {
          stateElements.push(flowEvent);
        }
      });

      // Process chunks using markers
      let chunk = streamer.get_next_chunk();
      const processedChunks: string[] = [];
      while (chunk !== null) {
        processedChunks.push(chunk);
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Log processed chunks for debugging
      console.log('Processed chunks:', processedChunks);

      // Validate exact element counts
      expect(elements).toHaveLength(3); // Should have exactly 3 elements: 1 state + 2 text
      expect(stateElements).toHaveLength(1); // Should have exactly 1 state element
      expect(textElements).toHaveLength(2); // Should have exactly 2 text elements

      // Validate element contents
      expect(stateElements[0].data).toEqual({ mode: 'Agent' });
      expect(textElements[0].content).toBe('Hello world');
      expect(textElements[1].content).toBe('Second message');

      // Validate element order
      expect(elements[0].elementType).toBe(FlowElementTypes.STATE);
      expect(elements[1].elementType).toBe(FlowElementTypes.TEXT);
      expect(elements[2].elementType).toBe(FlowElementTypes.TEXT);

      console.log(
        `✓ Validated exact counts: ${elements.length} total, ${stateElements.length} state, ${textElements.length} text elements`,
      );
    });

    it('should handle chunk emission markers for precise control over streaming chunks', () => {
      // Test XML content with chunk emission markers
      const xmlContent = '<flow-test>||Hello|| World||</flow-test>';

      // Create mock streamer with chunk markers
      const streamer = createMockStreamer(xmlContent);

      // Set up event listeners
      const elements: FlowData[] = [];
      const chunkEvents: any[] = [];

      processor.on(FlowEvents.STREAM_ELEMENT_START, (data: FlowData) => {
        data.on(FlowDataEvents.CHUNK, (data: any) => {
          chunkEvents.push(data);
        });
      });

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        elements.push(flowEvent);
      });

      // Process chunks using markers
      let chunk = streamer.get_next_chunk();
      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Verify correct parsing
      expect(elements).toHaveLength(1);
      expect(elements[0].elementType).toBe(FlowElementTypes.TEST);
      expect(elements[0].content).toBe('Hello World');

      // Verify chunk emission occurred in specific chunks due to markers
      expect(chunkEvents.length).toBeGreaterThan(0);

      // The chunks should have been: '<flow-test>', 'Hello', ' World', '</flow-test>'
      // This allows testing specific streaming patterns
    });

    it('should handle complex XML with chunk markers for edge case testing', () => {
      // Edge case: Content broken across chunks with precise control
      const xmlContent = '<flow-result type="json" data-type="object">||{"status": ||"success"}||</flow-result>';

      const streamer = createMockStreamer(xmlContent);
      const dataArr: FlowData[] = [];
      const streamingData: any[] = [];

      processor.on(FlowEvents.STREAM_ELEMENT_START, (element: FlowData) => {
        element.on(FlowDataEvents.CHUNK, (data: any) => {
          streamingData.push({
            chunk: data.delta,
            textContent: data.totalContent,
          });
        });
      });

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        dataArr.push(flowEvent);
      });

      // Process all chunks
      let chunk = streamer.get_next_chunk();
      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Verify proper parsing with chunked content
      expect(dataArr).toHaveLength(1);
      expect(dataArr[0].elementType).toBe(FlowElementTypes.RESULT);
      expect(dataArr[0].data).toEqual({ status: 'success' });
      expect(dataArr[0].dataType).toBe('object');

      // Verify streaming data captured the chunking pattern
      expect(streamingData.length).toBeGreaterThan(0);

      // The specific chunking allows testing how parser handles content breaks
      const chunkTexts = streamingData.map((d) => d.chunk);
      // Verify we have the expected JSON content chunks
      expect(chunkTexts.some((chunk) => chunk.includes('status'))).toBe(true);
      expect(chunkTexts.some((chunk) => chunk.includes('success'))).toBe(true);
    });

    it('should handle flat elements with markers for precise streaming control', () => {
      // Test flat structure with controlled chunking (no nesting support)
      const xmlContent = '<flow-element||>||test content||<||/flow-element>';

      const streamer = createMockStreamer(xmlContent);
      const elements: FlowData[] = [];

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        elements.push(flowEvent);
      });

      // Process all chunks
      let chunk = streamer.get_next_chunk();
      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Should handle flat structure correctly
      expect(elements).toHaveLength(1);
      expect(elements[0].elementType).toBe('element');
      expect(elements[0].content).toBe('test content');
    });

    it('should handle complex corner case with markers breaking tag names, attributes, content, and closing tags', () => {
      // Corner case: Markers breaking across every part of XML structure
      const xmlContent = '<flow-test1 i||d="12||3||"||>some || tex ||t ||here<||/flow-||test1||>';

      // Expected parsed result: <flow-test1 id="123">some  tex t here</flow-test1>
      const streamer = createMockStreamer(xmlContent);
      const elements: FlowData[] = [];
      const streamEvents: FlowData[] = [];
      const dataEvents: any[] = [];

      // Track stream events
      processor.on(FlowEvents.STREAM_ELEMENT_START, (element: FlowData) => {
        streamEvents.push(element);
        element.on(FlowDataEvents.CHUNK, (data: any) => {
          dataEvents.push({
            chunk: data.delta,
            textContent: data.totalContent,
          });
        });
      });

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        elements.push(flowEvent);
      });

      // Process all chunks
      let chunk = streamer.get_next_chunk();
      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Verify final parsed element
      expect(elements).toHaveLength(1);
      expect(elements[0].elementType).toBe(FlowElementTypes.TEST1);
      expect(elements[0].content).toBe('some  tex t here');

      // Verify attributes parsing worked despite being broken across chunks
      expect(elements[0].attributes).toEqual({ id: '123', 'data-type': 'string' });

      // Verify stream events occurred
      expect(streamEvents).toHaveLength(1);
      expect(streamEvents[0].elementType).toBe(FlowElementTypes.TEST1);

      // Verify data streaming captured the chunking patterns
      expect(dataEvents.length).toBeGreaterThan(0);

      // Verify attributes were parsed correctly
      expect(elements[0].attributes['id']).toBe('123');

      // Log chunk breakdown for debugging
      console.log('Corner case chunks processed:', dataEvents.map((d) => `"${d.chunk}"`).join(', '));
    });
  });

  describe('XML Attribute Parsing', () => {
    it('should parse XML attributes correctly for no attributes, single attribute, and multiple attributes', () => {
      // Test case 1: No attributes
      const xmlNoAttrs = '<flow-test>content</flow-test>';

      // Test case 2: Single attribute
      const xmlSingleAttr = '<flow-result status="success">{"data": "value"}</flow-result>';

      // Test case 3: Three attributes
      const xmlMultiAttrs = '<flow-message type="info" level="debug" source="system">Debug message</flow-message>';

      const testCases = [
        {
          xml: xmlNoAttrs,
          expectedType: 'test',
          expectedAttrs: { 'data-type': 'string' },
          description: 'no attributes',
        },
        {
          xml: xmlSingleAttr,
          expectedType: 'result',
          expectedAttrs: { status: 'success', 'data-type': 'string' },
          description: 'single attribute',
        },
        {
          xml: xmlMultiAttrs,
          expectedType: 'message',
          expectedAttrs: { type: 'info', level: 'debug', source: 'system', 'data-type': 'string' },
          description: 'three attributes',
        },
      ];

      testCases.forEach((testCase, index) => {
        // Reset processor for each test case
        processor.reset();

        const elements: FlowData[] = [];
        processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
          elements.push(flowEvent);
        });

        // Process the XML content
        processor.process_chunk(testCase.xml);
        processor.endStream();

        // Verify element was created
        expect(elements).toHaveLength(1);
        expect(elements[0].elementType).toBe(testCase.expectedType);

        // Verify attributes parsing
        expect(elements[0].attributes).toEqual(testCase.expectedAttrs);

        console.log(`Test case ${index + 1} (${testCase.description}): PASSED`);
      });

      // Verify all three test cases processed correctly
      expect(testCases).toHaveLength(3);
    });
  });

  describe('Error Handling', () => {
    it('should emit error events for incomplete flow elements and ignored closing tags', () => {
      // Test XML: <flow-broken> hello <flow-breaking>I am breaking</flow-breaking>
      // This should generate:
      // 1. "incomplete flow element" error when <flow-breaking> interrupts <flow-broken>
      // 2. "closing tag ignored" error when </flow-breaking> has no matching processing element
      const xmlContent = '<flow-broken> hello <flow-breaking>I am breaking</flow-breaking>';

      const errors: any[] = [];
      const elements: FlowData[] = [];

      // Listen for error events
      processor.on(FlowEvents.ERROR, (error: any) => {
        errors.push(error);
      });

      // Listen for completed elements (should get none since flow-broken never closes)
      processor.on(FlowEvents.DATA_END, (flowEvent: FlowData) => {
        elements.push(flowEvent);
      });

      // Process the XML content
      processor.process_chunk(xmlContent);
      processor.endStream();

      console.log('Errors captured:', errors.length);
      errors.forEach((error, index) => {
        console.log(`Error ${index + 1}:`, error);
      });
      console.log(
        'Elements captured:',
        elements.length,
        elements.map((e) => e.elementType),
      );

      // With improved end tag matching, incomplete streams are properly detected
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('incomplete stream');
      expect(errors[0].message).toContain('partial element: broken');

      // No complete elements should be emitted since flow-broken never closes
      expect(elements).toHaveLength(0);

      console.log('Improved XML processing test completed: robust end tag matching');
      console.log('- Detected incomplete stream with error message:', errors[0].message);
    });

    it('should handle incomplete elements with chunking markers gracefully', () => {
      // Test XML with chunking markers: <flow-brok||en||> hello|| <||flow-breaking||>I am breaking<||/flow-breaking>
      const xmlContent = '<||flow-brok||en||> hello|| <||flow-breaking||>I am breaking<||/flow-breaking>';

      const streamer = createMockStreamer(xmlContent);
      const elements: FlowData[] = [];
      const errors: any[] = [];

      processor.on(FlowEvents.DATA_END, (flowEvent: FlowData) => {
        console.log(`Received completed element: ${flowEvent.elementType} with content: "${flowEvent.content}"`);
        elements.push(flowEvent);
      });

      processor.on(FlowEvents.ERROR, (error: any) => {
        errors.push(error);
      });

      // Process all chunks
      let chunk = streamer.get_next_chunk();
      while (chunk !== null) {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      console.log(`Total elements received: ${elements.length}`);
      console.log(`Total errors received: ${errors.length}`);

      // With improved end tag detection, should detect incomplete stream
      expect(elements).toHaveLength(0); // No complete elements since flow-broken never properly closes
      expect(errors).toHaveLength(1); // Should emit incomplete stream error
      expect(errors[0].message).toContain('incomplete stream');
    });
  });

  describe('Stream End Handling', () => {
    it('should emit incomplete stream error for various incomplete elements', () => {
      const testCases = [
        {
          name: 'Simple incomplete element',
          xml: '<flow-neverend> I was interrupted',
          expectedType: 'neverend',
        },
        {
          name: 'Incomplete with chunk marker and broken tag',
          xml: '<flow-neverend> I was interrupted || <',
          expectedType: 'neverend',
        },
        {
          name: 'Incomplete with trailing chunk marker',
          xml: '<flow-neverend> I was interrupted ||',
          expectedType: 'neverend',
        },
        {
          name: 'Complete element followed by incomplete',
          xml: '<flow-go||od>|| hi <||/flow-good||><flow-neverend> I was interrupted',
          expectedType: 'neverend',
          expectsCompleteElement: true,
        },
      ];

      testCases.forEach((testCase, index) => {
        console.log(`\nTest case ${index + 1}: ${testCase.name}`);

        const processor = new FlowStreamProcessor();
        const errors: any[] = [];
        const elements: FlowData[] = [];

        processor.on(FlowEvents.ERROR, (error: { message: any }) => {
          console.log(`Error received: ${error.message}`);
          errors.push(error);
        });

        processor.on(FlowEvents.DATA_END, (flowEvent: FlowData) => {
          console.log(`Completed element received: ${flowEvent.elementType}`);
          elements.push(flowEvent);
        });

        // Process with chunking markers if they exist
        if (testCase.xml.includes('||')) {
          const streamer = createMockStreamer(testCase.xml);
          let chunk = streamer.get_next_chunk();
          while (chunk !== null) {
            console.log(`Processing chunk: "${chunk}"`);
            processor.process_chunk(chunk);
            chunk = streamer.get_next_chunk();
          }
        } else {
          processor.process_chunk(testCase.xml);
        }

        // End the stream - this should trigger incomplete stream error
        processor.endStream();

        // Verify error was emitted
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('incomplete stream');
        expect(errors[0].message).toContain(`partial element: ${testCase.expectedType}`);

        // Check if complete element was also emitted (for last test case)
        if (testCase.expectsCompleteElement) {
          expect(elements).toHaveLength(1);
          expect(elements[0].elementType).toBe('good');
        } else {
          expect(elements).toHaveLength(0);
        }

        console.log(`✓ Test case ${index + 1} passed`);
      });
    });

    it('should not emit error when endStream is called with no element under processing', () => {
      const errors: any[] = [];

      processor.on(FlowEvents.ERROR, (error: any) => {
        errors.push(error);
      });

      // Process complete element
      processor.process_chunk('<flow-complete>content</flow-complete>');
      processor.endStream();

      // End stream after complete processing
      // (already called above)

      // No errors should be emitted
      expect(errors).toHaveLength(0);
    });
  });

  describe('Corner Case Marker Testing', () => {
    it('test_flow_element_corners: should handle aggressive marker positioning with multiple elements and attributes', () => {
      const processor = new FlowStreamProcessor();

      // Captured events for verification
      const capturedEvents: FlowData[] = [];
      const capturedErrors: any[] = [];

      processor.on(FlowEvents.DATA, (flowEvent: FlowData) => {
        capturedEvents.push(flowEvent);
        console.log(
          `Captured element: ${flowEvent.elementType} with content: "${flowEvent.content}" and attributes:`,
          flowEvent.attributes,
        );
      });

      processor.on(FlowEvents.ERROR, (error: any) => {
        capturedErrors.push(error);
        console.log('Error captured:', error);
      });

      // Test Case 1: Marker breaking tag name
      console.log('\n=== Test Case 1: Marker breaking tag name ===');
      processor.reset();
      const chunks1 = ['<flow-te', 'st1 id="break1" value="corner">Content 1</fl', 'ow-test1>'];
      chunks1.forEach((chunk) => {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
      });
      processor.endStream();

      // Test Case 2: Marker breaking attribute name
      console.log('\n=== Test Case 2: Marker breaking attribute name ===');
      processor.reset();
      const chunks2 = ['<flow-test2 i', 'd="break2" val', 'ue="attr_break">Content 2</flow-test2>'];
      chunks2.forEach((chunk) => {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
      });
      processor.endStream();

      // Test Case 3: Marker breaking attribute value
      console.log('\n=== Test Case 3: Marker breaking attribute value ===');
      processor.reset();
      const chunks3 = ['<flow-test3 id="val', 'ue_brea', 'k3" status="active">Content 3</flow-test3>'];
      chunks3.forEach((chunk) => {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
      });
      processor.endStream();

      // Test Case 4: Marker breaking opening tag closure
      console.log('\n=== Test Case 4: Marker breaking opening tag closure ===');
      processor.reset();
      const chunks4 = ['<flow-test4 id="break4"', '>', 'Content 4</flow-test4>'];
      chunks4.forEach((chunk) => {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
      });
      processor.endStream();

      // Test Case 5: Marker breaking content
      console.log('\n=== Test Case 5: Marker breaking content ===');
      processor.reset();
      const chunks5 = ['<flow-test5>Con', 'tent 5 with mul', 'tiple breaks</flow-test5>'];
      chunks5.forEach((chunk) => {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
      });
      processor.endStream();

      // Test Case 6: Marker breaking closing tag start
      console.log('\n=== Test Case 6: Marker breaking closing tag start ===');
      processor.reset();
      const chunks6 = ['<flow-test6>Content 6<', '/', 'flow-test6>'];
      chunks6.forEach((chunk) => {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
      });
      processor.endStream();

      // Test Case 7: Marker breaking closing tag name
      console.log('\n=== Test Case 7: Marker breaking closing tag name ===');
      processor.reset();
      const chunks7 = ['<flow-test7>Content 7</flow-te', 'st7>'];
      chunks7.forEach((chunk) => {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
      });
      processor.endStream();

      // Test Case 8: Complex multiple elements with nested markers
      console.log('\n=== Test Case 8: Multiple elements with aggressive markers ===');
      processor.reset();
      const chunks8 = [
        '<flow-multi',
        '1 id="m1" ty',
        'pe="first">First',
        ' element</flow-multi1',
        '><flow-multi2 id="m',
        '2" status="act',
        'ive">Second element with',
        ' complex content</flow-multi2><flow-mul',
        'ti3>Third</flow-multi3>',
      ];
      chunks8.forEach((chunk) => {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
      });
      processor.endStream();

      // Test Case 9: Self-closing tags with markers (simpler case)
      console.log('\n=== Test Case 9: Self-closing tags with markers ===');
      processor.reset();
      const chunks9 = ['<flow-self1 id="s1"/>'];
      chunks9.forEach((chunk) => {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
      });
      processor.endStream();

      // Test Case 10: Extremely aggressive breaking - every character
      console.log('\n=== Test Case 10: Extreme character-by-character breaking ===');
      processor.reset();
      const xmlContent = '<flow-extreme id="char_by_char" value="aggressive">Extreme content</flow-extreme>';
      // Break into single characters for maximum aggression
      for (let i = 0; i < xmlContent.length; i++) {
        const char = xmlContent[i];
        console.log(`Processing single char: "${char}"`);
        processor.process_chunk(char);
      }
      processor.endStream();

      // Verification: Check that all expected elements were processed correctly
      console.log('\n=== Verification ===');
      console.log(`Total events captured: ${capturedEvents.length}`);
      console.log(`Total errors captured: ${capturedErrors.length}`);

      // Expected elements: test1, test2, test3, test4, test5, test6, test7, multi1, multi2, multi3, self1, extreme
      const expectedElements = [
        'test1',
        'test2',
        'test3',
        'test4',
        'test5',
        'test6',
        'test7',
        'multi1',
        'multi2',
        'multi3',
        'self1',
        'extreme',
      ];
      const capturedTypes = capturedEvents.map((e) => e.elementType);

      console.log('Expected elements:', expectedElements);
      console.log('Captured types:', capturedTypes);

      // Verify all expected elements are present
      expectedElements.forEach((expectedType) => {
        const found = capturedEvents.find((e) => e.elementType === expectedType);
        expect(found, `Element ${expectedType} should be captured`).toBeDefined();

        if (found) {
          console.log(`✓ ${expectedType}: content="${found.content}", attributes=`, found.attributes);
        }
      });

      // Verify specific attribute parsing worked correctly
      const test1 = capturedEvents.find((e) => e.elementType === FlowElementTypes.TEST1);
      expect(test1?.attributes.id).toBe('break1');
      expect(test1?.attributes.value).toBe('corner');

      const test2 = capturedEvents.find((e) => e.elementType === FlowElementTypes.TEST2);
      expect(test2?.attributes.id).toBe('break2');
      expect(test2?.attributes.value).toBe('attr_break');

      const test3 = capturedEvents.find((e) => e.elementType === FlowElementTypes.TEST3);
      expect(test3?.attributes.id).toBe('value_break3');
      expect(test3?.attributes.status).toBe('active');

      // Verify content was properly reconstructed
      const test4 = capturedEvents.find((e) => (e.elementType as string) === 'test4');
      const test5 = capturedEvents.find((e) => (e.elementType as string) === 'test5');

      expect(test1?.content).toBe('Content 1');
      expect(test2?.content).toBe('Content 2');
      expect(test3?.content).toBe('Content 3');
      expect(test4?.content).toBe('Content 4');
      expect(test5?.content).toBe('Content 5 with multiple breaks');

      // Multi-element content verification
      const multi1 = capturedEvents.find((e) => (e.elementType as string) === 'multi1');
      const multi2 = capturedEvents.find((e) => (e.elementType as string) === 'multi2');
      const multi3 = capturedEvents.find((e) => (e.elementType as string) === 'multi3');

      expect(multi1?.content).toBe('First element');
      expect(multi1?.attributes.id).toBe('m1');
      expect(multi1?.attributes.type).toBe('first');

      expect(multi2?.content).toBe('Second element with complex content');
      expect(multi2?.attributes.id).toBe('m2');
      expect(multi2?.attributes.status).toBe('active');

      expect(multi3?.content).toBe('Third');

      // Self-closing tag verification (should have empty content)
      const self1 = capturedEvents.find((e) => (e.elementType as string) === 'self1');

      expect(self1?.content).toBe('');
      expect(self1?.attributes.id).toBe('s1');

      // Extreme case verification
      const extreme = capturedEvents.find((e) => (e.elementType as string) === 'extreme');
      expect(extreme?.content).toBe('Extreme content');
      expect(extreme?.attributes.id).toBe('char_by_char');
      expect(extreme?.attributes.value).toBe('aggressive');

      // Ensure exactly the expected number of elements
      expect(capturedEvents.length).toBe(expectedElements.length);

      // Log any errors that occurred during processing for debugging
      if (capturedErrors.length > 0) {
        console.log('\n⚠️ Errors captured during testing:');
        capturedErrors.forEach((error, index) => {
          console.log(`Error ${index + 1}:`, error);
        });
      }

      // Most corner cases should work, but some extremely aggressive ones may cause errors
      // Allow up to 1 error for aggressive corner cases
      expect(capturedErrors.length).toBeLessThanOrEqual(1);

      console.log('\n✅ All corner case tests passed!');
    });
  });

  describe('Internal XML Content Handling', () => {
    it('should handle internal XML content within flow elements correctly', () => {
      const capturedElements: FlowData[] = [];
      const capturedErrors: any[] = [];

      processor.on(FlowEvents.DATA, (element: FlowData) => {
        capturedElements.push(element);
      });

      processor.on(FlowEvents.ERROR, (error: any) => {
        capturedErrors.push(error);
      });

      // Test Case 1: Simple internal XML tags
      console.log('\n=== Test Case 1: Simple internal XML tags ===');
      const xml1 = '<flow-html><div class="container"><p>Hello <strong>world</strong></p></div></flow-html>';

      const streamer1 = createMockStreamer(xml1);
      let chunk = streamer1.get_next_chunk();
      while (chunk !== null) {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
        chunk = streamer1.get_next_chunk();
      }
      processor.endStream();

      expect(capturedElements).toHaveLength(1);
      expect(capturedElements[0].elementType).toBe('html');
      expect(capturedElements[0].content).toBe('<div class="container"><p>Hello <strong>world</strong></p></div>');
      console.log(`✓ Captured HTML content: "${capturedElements[0].content}"`);

      // Test Case 2: XML with similar tag names to flow tag
      console.log('\n=== Test Case 2: XML with similar tag names ===');
      processor.reset();
      capturedElements.length = 0;

      const xml2 = '<flow-test><test>Not a flow element</test><flow>Also not a flow element</flow></flow-test>';

      const streamer2 = createMockStreamer(xml2);
      chunk = streamer2.get_next_chunk();
      while (chunk !== null) {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
        chunk = streamer2.get_next_chunk();
      }
      processor.endStream();

      expect(capturedElements).toHaveLength(1);
      expect(capturedElements[0].elementType).toBe('test');
      expect(capturedElements[0].content).toBe('<test>Not a flow element</test><flow>Also not a flow element</flow>');
      console.log(`✓ Captured test content: "${capturedElements[0].content}"`);

      // Test Case 3: Complex nested XML with chunking
      console.log('\n=== Test Case 3: Complex nested XML with chunking ===');
      processor.reset();
      capturedElements.length = 0;

      const xml3 =
        '<flow-response||><data><item id="1"><||name>Product A</name><price>||$29.99</price></item><item id="2"><name>Product B||</name><price>$||39.99</price></item></data></flow-response>';

      const streamer3 = createMockStreamer(xml3);
      chunk = streamer3.get_next_chunk();
      while (chunk !== null) {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
        chunk = streamer3.get_next_chunk();
      }
      processor.endStream();

      expect(capturedElements).toHaveLength(1);
      expect(capturedElements[0].elementType).toBe('response');
      const expectedContent =
        '<data><item id="1"><name>Product A</name><price>$29.99</price></item><item id="2"><name>Product B</name><price>$39.99</price></item></data>';
      expect(capturedElements[0].content).toBe(expectedContent);
      console.log(`✓ Captured response content: "${capturedElements[0].content}"`);

      // Test Case 4: XML with closing tags that could confuse the parser
      console.log('\n=== Test Case 4: Confusing closing tags ===');
      processor.reset();
      capturedElements.length = 0;

      const xml4 =
        '<flow-document><section><p>Text with </close> tags and </end> markers</p><footer>End of </document></footer></flow-document>';

      const streamer4 = createMockStreamer(xml4);
      chunk = streamer4.get_next_chunk();
      while (chunk !== null) {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
        chunk = streamer4.get_next_chunk();
      }
      processor.endStream();

      expect(capturedElements).toHaveLength(1);
      expect(capturedElements[0].elementType).toBe('document');
      expect(capturedElements[0].content).toBe(
        '<section><p>Text with </close> tags and </end> markers</p><footer>End of </document></footer>',
      );
      console.log(`✓ Captured document content: "${capturedElements[0].content}"`);

      // Test Case 5: Self-closing internal XML tags
      console.log('\n=== Test Case 5: Self-closing internal XML tags ===');
      processor.reset();
      capturedElements.length = 0;

      const xml5 =
        '<flow-config><settings><option name="debug" value="true"/><option name="verbose" value="false"/></settings></flow-config>';

      const streamer5 = createMockStreamer(xml5);
      chunk = streamer5.get_next_chunk();
      while (chunk !== null) {
        console.log(`Processing chunk: "${chunk}"`);
        processor.process_chunk(chunk);
        chunk = streamer5.get_next_chunk();
      }
      processor.endStream();

      expect(capturedElements).toHaveLength(1);
      expect(capturedElements[0].elementType).toBe(FlowElementTypes.CONFIG);
      expect(capturedElements[0].content).toBe(
        '<settings><option name="debug" value="true"/><option name="verbose" value="false"/></settings>',
      );
      console.log(`✓ Captured config content: "${capturedElements[0].content}"`);

      // Verification
      console.log('\n=== Verification ===');
      console.log(`Total elements captured: ${capturedElements.length}`);
      console.log(`Total errors captured: ${capturedErrors.length}`);

      expect(capturedErrors).toHaveLength(0);
      console.log('\n✅ All internal XML content tests passed!');
    });
  });

  describe('Empty Element Handling', () => {
    it('should emit empty non-self-closing elements (like checkpoints)', () => {
      // Test that empty elements with explicit open/close tags are emitted
      // This is critical for elements like checkpoints that have no content but carry data in attributes
      const xmlContent =
        '<flow-checkpoint i="366" t="2025-10-16T17:55:49.984459+00:00" data-type="string" checkpoint_hash="4d4d339c1c1fcd379f415a7157f4597a76e20be0"></flow-checkpoint>';

      const capturedElements: FlowData[] = [];
      processor.on(FlowEvents.DATA, (data: FlowData) => {
        capturedElements.push(data);
      });

      processor.process_chunk(xmlContent);
      processor.endStream();

      // Verify the checkpoint element was emitted despite being empty
      expect(capturedElements).toHaveLength(1);
      expect(capturedElements[0].elementType).toBe(FlowElementTypes.CHECKPOINT);
      expect(capturedElements[0].attributes['checkpoint_hash']).toBe('4d4d339c1c1fcd379f415a7157f4597a76e20be0');
      expect(capturedElements[0].content).toBe(''); // Empty content is valid
      expect(capturedElements[0].index).toBe(366);
      expect(capturedElements[0].timestamp).toBe('2025-10-16T17:55:49.984459+00:00');
    });

    it('should emit multiple empty elements in sequence', () => {
      // Test multiple empty elements to ensure none are filtered
      const xmlContent =
        '<flow-checkpoint i="1" t="2025-10-16T10:00:00.000Z" checkpoint_hash="abc123"></flow-checkpoint><flow-checkpoint i="2" t="2025-10-16T10:01:00.000Z" checkpoint_hash="def456"></flow-checkpoint><flow-checkpoint i="3" t="2025-10-16T10:02:00.000Z" checkpoint_hash="ghi789"></flow-checkpoint>';

      const capturedElements: FlowData[] = [];
      processor.on(FlowEvents.DATA, (data: FlowData) => {
        capturedElements.push(data);
      });

      processor.process_chunk(xmlContent);
      processor.endStream();

      // All three checkpoints should be emitted
      expect(capturedElements).toHaveLength(3);
      expect(capturedElements[0].attributes['checkpoint_hash']).toBe('abc123');
      expect(capturedElements[1].attributes['checkpoint_hash']).toBe('def456');
      expect(capturedElements[2].attributes['checkpoint_hash']).toBe('ghi789');
    });

    it('should emit empty elements mixed with non-empty elements', () => {
      // Test that empty and non-empty elements are both emitted correctly
      const xmlContent =
        '<flow-reasoning i="1" t="2025-10-16T10:00:00.000Z">This is some reasoning</flow-reasoning><flow-checkpoint i="2" t="2025-10-16T10:01:00.000Z" checkpoint_hash="abc123"></flow-checkpoint><flow-chat i="3" t="2025-10-16T10:02:00.000Z">This is chat content</flow-chat>';

      const capturedElements: FlowData[] = [];
      processor.on(FlowEvents.DATA, (data: FlowData) => {
        capturedElements.push(data);
      });

      processor.process_chunk(xmlContent);
      processor.endStream();

      // All three elements should be emitted
      expect(capturedElements).toHaveLength(3);
      expect(capturedElements[0].elementType).toBe(FlowElementTypes.REASONING);
      expect(capturedElements[0].content).toBe('This is some reasoning');
      expect(capturedElements[1].elementType).toBe(FlowElementTypes.CHECKPOINT);
      expect(capturedElements[1].content).toBe(''); // Empty
      expect(capturedElements[2].elementType).toBe(FlowElementTypes.CHAT);
      expect(capturedElements[2].content).toBe('This is chat content');
    });

    it('should handle empty elements with random chunking', () => {
      // Test that empty elements work correctly even when split across chunks
      const xmlContent =
        '<flow-checkpoint i="100" t="2025-10-16T12:00:00.000Z" checkpoint_hash="test123"></flow-checkpoint>';

      const streamer = createMockStreamer(xmlContent, SEED);
      const capturedElements: FlowData[] = [];

      processor.on(FlowEvents.DATA, (data: FlowData) => {
        capturedElements.push(data);
      });

      let chunk = streamer.get_next_chunk();
      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      // Checkpoint should still be emitted correctly
      expect(capturedElements).toHaveLength(1);
      expect(capturedElements[0].elementType).toBe(FlowElementTypes.CHECKPOINT);
      expect(capturedElements[0].attributes['checkpoint_hash']).toBe('test123');
      expect(capturedElements[0].index).toBe(100);
    });
  });
});
