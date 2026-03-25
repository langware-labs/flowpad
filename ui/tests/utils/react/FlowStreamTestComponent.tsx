import { FlowData, FlowEvents, FlowStreamProcessor } from '@sdk';
import React, { useEffect, useRef, useState } from 'react';
import { MockXMLStreamer } from '../../unit/mock_flow_streamer_test_utils';

export interface FlowStreamEvent {
  type: string;
  data: FlowData;
  timestamp: number;
}

export interface FlowStreamTestComponentProps {
  xmlContent: string;
  streamSeed?: number;
  onEvent?: (event: FlowStreamEvent) => void;
  onStreamComplete?: (events: FlowStreamEvent[]) => void;
  autoStart?: boolean;
  chunkDelay?: number; // Delay between chunks in ms
}

/**
 * React component for testing flow stream processing in jsdom environment
 * Provides a controlled environment for testing XML stream parsing with React
 */
export const FlowStreamTestComponent: React.FC<FlowStreamTestComponentProps> = ({
  xmlContent,
  streamSeed = 42,
  onEvent,
  onStreamComplete,
  autoStart = true,
  chunkDelay = 0,
}) => {
  const [events, setEvents] = useState<FlowStreamEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamProgress, setStreamProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const processorRef = useRef<FlowStreamProcessor | null>(null);
  const streamerRef = useRef<MockXMLStreamer | null>(null);
  const eventsRef = useRef<FlowStreamEvent[]>([]);

  // Initialize processor and streamer
  useEffect(() => {
    processorRef.current = new FlowStreamProcessor();
    streamerRef.current = new MockXMLStreamer(xmlContent, streamSeed);

    // Setup event listeners
    const processor = processorRef.current;

    const handleData = (flowData: FlowData) => {
      const event: FlowStreamEvent = {
        type: FlowEvents.DATA,
        data: flowData,
        timestamp: Date.now(),
      };

      eventsRef.current.push(event);
      setEvents([...eventsRef.current]);

      if (onEvent) {
        onEvent(event);
      }
    };

    // Listen to main data event
    processor.on(FlowEvents.DATA, handleData);

    // Listen to specific data type events
    const dataTypes = ['result', 'shell', 'error', 'thought', 'plan', 'step'];
    dataTypes.forEach((type) => {
      processor.on(`data:${type}`, (flowData: FlowData) => {
        const event: FlowStreamEvent = {
          type: `data:${type}`,
          data: flowData,
          timestamp: Date.now(),
        };

        eventsRef.current.push(event);
        setEvents([...eventsRef.current]);

        if (onEvent) {
          onEvent(event);
        }
      });
    });

    // Cleanup
    return () => {
      processor.off(FlowEvents.DATA, handleData);
      dataTypes.forEach((type) => {
        processor.removeAllListeners(`data:${type}`);
      });
    };
  }, [xmlContent, streamSeed, onEvent]);

  // Start streaming function
  const startStream = async () => {
    if (!processorRef.current || !streamerRef.current || isStreaming) {
      return;
    }

    setIsStreaming(true);
    setError(null);
    eventsRef.current = [];
    setEvents([]);
    setStreamProgress(0);

    const processor = processorRef.current;
    const streamer = streamerRef.current;

    try {
      streamer.reset();
      let chunk = streamer.get_next_chunk();
      let _totalChunks = 0;

      while (chunk !== null) {
        processor.process_chunk(chunk);
        _totalChunks++;

        // Update progress
        const remaining = streamer.getRemainingContent();
        const totalLength = xmlContent.replace(/\|\|/g, '').length;
        const processedLength = totalLength - remaining.length;
        setStreamProgress(Math.round((processedLength / totalLength) * 100));

        // Add delay if specified
        if (chunkDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, chunkDelay));
        }

        chunk = streamer.get_next_chunk();
      }

      processor.endStream();
      setStreamProgress(100);

      if (onStreamComplete) {
        onStreamComplete(eventsRef.current);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsStreaming(false);
    }
  };

  // Auto-start streaming if enabled
  useEffect(() => {
    if (autoStart) {
      void startStream();
    }
  }, [autoStart]);

  // Reset function
  const reset = () => {
    if (processorRef.current) {
      processorRef.current = new FlowStreamProcessor();
    }
    if (streamerRef.current) {
      streamerRef.current.reset();
    }
    eventsRef.current = [];
    setEvents([]);
    setStreamProgress(0);
    setError(null);
    setIsStreaming(false);
  };

  return (
    <div className="flow-stream-test-component">
      <div className="controls">
        <button onClick={startStream} disabled={isStreaming}>
          {isStreaming ? 'Streaming...' : 'Start Stream'}
        </button>
        <button onClick={reset} disabled={isStreaming}>
          Reset
        </button>
      </div>

      <div className="status">
        <div>Status: {isStreaming ? 'Streaming' : 'Idle'}</div>
        <div>Progress: {streamProgress}%</div>
        <div>Events: {events.length}</div>
        {error && <div className="error">Error: {error}</div>}
      </div>

      <div className="events">
        <h3>Events</h3>
        <ul>
          {events.map((event, index) => (
            <li key={index} data-event-type={event.type}>
              <span className="event-type">{event.type}</span>
              <span className="event-tag">{event.data.elementType}</span>
              <span className="event-data-type">{event.data.dataType}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

/**
 * Hook for testing flow streaming without rendering component
 */
export function useProcessStreamTest(
  xmlContent: string,
  options?: {
    streamSeed?: number;
    autoStart?: boolean;
  },
) {
  const [events, setEvents] = useState<FlowStreamEvent[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const processorRef = useRef<FlowStreamProcessor | null>(null);
  const streamerRef = useRef<MockXMLStreamer | null>(null);

  useEffect(() => {
    processorRef.current = new FlowStreamProcessor();
    streamerRef.current = new MockXMLStreamer(xmlContent, options?.streamSeed || 42);

    const processor = processorRef.current;
    const streamer = streamerRef.current;
    const collectedEvents: FlowStreamEvent[] = [];

    // Setup listeners
    processor.on(FlowEvents.DATA, (flowData: FlowData) => {
      collectedEvents.push({
        type: FlowEvents.DATA,
        data: flowData,
        timestamp: Date.now(),
      });
    });

    // Process stream
    if (options?.autoStart !== false) {
      let chunk = streamer.get_next_chunk();
      while (chunk !== null) {
        processor.process_chunk(chunk);
        chunk = streamer.get_next_chunk();
      }
      processor.endStream();

      setEvents(collectedEvents);
      setIsComplete(true);
    }

    return () => {
      processor.removeAllListeners();
    };
  }, [xmlContent, options?.streamSeed, options?.autoStart]);

  return { events, isComplete, processor: processorRef.current, streamer: streamerRef.current };
}
