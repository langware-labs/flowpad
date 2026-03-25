import { Flow, FlowStateProperty, TypeId } from '@sdk';
import { useProcessStateField, useProcessStream } from '@src/hooks/flow-hooks';
import React, { useMemo } from 'react';

interface FlowStateDebugProps {
  flow: Flow | null;
}

/**
 * Debug panel for flow state inspection during testing
 * Uses useProcessStateField and useProcessStream hooks to get data
 * NOTE: Uses specific state keys to avoid infinite loops from stateJson
 */
export const FlowStateDebug: React.FC<FlowStateDebugProps> = ({ flow }) => {
  const flowTypeId = useMemo(() => (flow ? new TypeId(Flow.type, flow.id) : null), [flow]);

  // Use hooks to get specific state properties (avoid useProcessStateField without key - causes infinite loop)
  const { state: chatOptions, lastUpdated: chatOptionsUpdated } = useProcessStateField(
    flowTypeId,
    FlowStateProperty.CHAT_OPTIONS,
  );
  const { state: runUsage, lastUpdated: runUsageUpdated } = useProcessStateField(flowTypeId, FlowStateProperty.RUN_USAGE);
  const { state: flowPhase } = useProcessStateField(flowTypeId, FlowStateProperty.FLOW_PHASE);
  const { data, isStreaming } = useProcessStream(flow);
  const messageCount = data.length;

  // Get the most recent update timestamp
  const lastUpdated =
    chatOptionsUpdated && runUsageUpdated
      ? chatOptionsUpdated > runUsageUpdated
        ? chatOptionsUpdated
        : runUsageUpdated
      : chatOptionsUpdated || runUsageUpdated;

  // Extract mode from chat_options (correct property path)
  const currentMode = chatOptions?.mode?.value || 'Unknown';

  // Build a debug state object from individual properties for display
  const debugState = flow?.state
    ? {
        chat_options: chatOptions,
        run_usage: runUsage,
        flow_phase: flowPhase,
      }
    : null;

  return (
    <div data-testid="flow-debug-panel" className="border-t bg-gray-50 p-4">
      <div className="font-semibold mb-2">Debug Info</div>

      <div className="grid grid-cols-2 gap-4 text-xs">
        <div>
          <div className="font-medium">Stream Status</div>
          <div data-testid="debug-streaming">{isStreaming ? 'Streaming' : 'Idle'}</div>
        </div>

        <div>
          <div className="font-medium">Message Count</div>
          <div data-testid="debug-message-count">{messageCount}</div>
        </div>

        <div>
          <div className="font-medium">Last Updated</div>
          <div data-testid="debug-last-updated">{lastUpdated ? lastUpdated.toLocaleTimeString() : 'Never'}</div>
        </div>

        <div>
          <div className="font-medium">Flow Mode</div>
          <div data-testid="debug-flow-mode">{currentMode}</div>
        </div>
      </div>

      {/* Flow State Details */}
      {debugState && (
        <details className="mt-4">
          <summary className="cursor-pointer font-medium">Flow State (Raw)</summary>
          <pre
            data-testid="debug-flow-state-raw"
            className="mt-2 text-xs bg-white p-2 rounded border overflow-x-auto max-h-40"
          >
            {JSON.stringify(debugState, null, 2)}
          </pre>
        </details>
      )}

      {/* Usage metrics */}
      {runUsage && (
        <details className="mt-2">
          <summary className="cursor-pointer font-medium">Usage Metrics</summary>
          <pre data-testid="debug-usage-metrics" className="mt-2 text-xs bg-white p-2 rounded border overflow-x-auto">
            {JSON.stringify(runUsage, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
};
