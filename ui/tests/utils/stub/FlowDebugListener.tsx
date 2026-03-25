import { FlowEvents } from '@sdk';
import React, { useEffect, useState } from 'react';

interface FlowDebugEvent {
  timestamp: string;
  event: string;
  processId: string | null;
  phase: 'initialization' | 'sending' | 'streaming' | 'processing' | 'completion' | 'error';
  data: any;
}

interface FlowDebugListenerProps {
  flow: any; // Flow instance
  maxEvents?: number;
  showRawData?: boolean;
}

export const FlowDebugListener: React.FC<FlowDebugListenerProps> = ({ flow, maxEvents = 50, showRawData = false }) => {
  const [debugEvents, setDebugEvents] = useState<FlowDebugEvent[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    if (!flow) return;

    const handleDebugEvent = (event: FlowDebugEvent) => {
      setDebugEvents((prev) => {
        const updated = [event, ...prev];
        return updated.slice(0, maxEvents);
      });
    };

    // Listen to debug events
    const unsubscribeDebug = flow.on(FlowEvents.DEBUG, handleDebugEvent);

    return () => {
      unsubscribeDebug();
    };
  }, [flow, maxEvents]);

  const clearEvents = () => {
    setDebugEvents([]);
  };

  const getPhaseColor = (phase: string) => {
    switch (phase) {
      case 'initialization':
        return 'text-blue-600';
      case 'sending':
        return 'text-orange-600';
      case 'streaming':
        return 'text-green-600';
      case 'processing':
        return 'text-purple-600';
      case 'completion':
        return 'text-emerald-600';
      case 'error':
        return 'text-red-600';
      default:
        return 'text-gray-600';
    }
  };

  if (!flow) {
    return (
      <div data-testid="debug-listener" className="p-4 bg-gray-100 rounded-lg">
        <div className="text-gray-500">No flow provided to debug listener</div>
      </div>
    );
  }

  return (
    <div data-testid="debug-listener" className="p-4 bg-gray-50 border rounded-lg">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="text-sm px-2 py-1 bg-gray-200 rounded hover:bg-gray-300"
            data-testid="toggle-debug-panel"
          >
            {isCollapsed ? '▶️' : '🔽'} Debug Events
          </button>
          <span className="text-xs text-gray-500" data-testid="debug-event-count">
            {debugEvents.length} events
          </span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={clearEvents}
            className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200"
            data-testid="clear-debug-events"
          >
            Clear
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {debugEvents.length === 0 ? (
            <div className="text-sm text-gray-500 italic" data-testid="no-debug-events">
              No debug events yet...
            </div>
          ) : (
            debugEvents.map((event, index) => (
              <div key={index} className="p-2 bg-white border rounded text-xs" data-testid={`debug-event-${index}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium" data-testid={`debug-event-name-${index}`}>
                    {event.event}
                  </span>
                  <span
                    className={`text-xs font-medium ${getPhaseColor(event.phase)}`}
                    data-testid={`debug-event-phase-${index}`}
                  >
                    {event.phase}
                  </span>
                </div>

                <div className="text-gray-600 mb-1" data-testid={`debug-event-context-${index}`}>
                  {event.data.context || 'No context'}
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="font-medium">Time:</span> {new Date(event.timestamp).toLocaleTimeString()}
                  </div>
                  <div>
                    <span className="font-medium">Flow:</span> {event.processId?.slice(0, 8) || 'N/A'}
                  </div>

                  {event.data.streamLoading !== undefined && (
                    <div>
                      <span className="font-medium">Streaming:</span> {event.data.streamLoading ? '✅' : '❌'}
                    </div>
                  )}

                  {event.data.elementCount !== undefined && (
                    <div>
                      <span className="font-medium">Elements:</span> {event.data.elementCount}
                    </div>
                  )}

                  {event.data.chunkSize && (
                    <div>
                      <span className="font-medium">Chunk:</span> {event.data.chunkSize} bytes
                    </div>
                  )}

                  {event.data.processingTime !== undefined && (
                    <div>
                      <span className="font-medium">Time:</span> {event.data.processingTime}ms
                    </div>
                  )}

                  {event.data.elementType && (
                    <div>
                      <span className="font-medium">Type:</span> {event.data.elementType}
                    </div>
                  )}

                  {event.data.error && (
                    <div className="col-span-2 text-red-600">
                      <span className="font-medium">Error:</span> {event.data.error}
                    </div>
                  )}
                </div>

                {showRawData && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-gray-500">Raw Data</summary>
                    <pre className="mt-1 text-xs bg-gray-100 p-1 rounded overflow-x-auto">
                      {JSON.stringify(event.data, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Summary Stats */}
      <div className="mt-3 pt-2 border-t text-xs">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="font-medium">{debugEvents.filter((e) => e.phase === 'processing').length}</div>
            <div className="text-gray-500">Processing</div>
          </div>
          <div>
            <div className="font-medium">{debugEvents.filter((e) => e.phase === 'error').length}</div>
            <div className="text-gray-500">Errors</div>
          </div>
          <div>
            <div className="font-medium">{debugEvents.filter((e) => e.event.includes('element')).length}</div>
            <div className="text-gray-500">Elements</div>
          </div>
        </div>
      </div>
    </div>
  );
};
