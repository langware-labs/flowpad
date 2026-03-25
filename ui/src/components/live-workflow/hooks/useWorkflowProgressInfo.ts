import { useCallback, useEffect, useRef, useState } from 'react';
import { AgenticProcess, FlowData } from '@sdk';

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Hook that provides elapsed time, live status message, activity label,
 * and token usage for a running session/process.
 */
export function useWorkflowProgressInfo(
  process: AgenticProcess | null,
  isRunning: boolean,
): {
  elapsedTime: string | null;
  statusMessage: string | null;
  activityLabel: string | null;
  tokenUsage: { input: number; output: number } | null;
} {
  const [elapsedTime, setElapsedTime] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [activityLabel, setActivityLabel] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<{ input: number; output: number } | null>(null);

  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Elapsed time ---
  useEffect(() => {
    if (isRunning) {
      // Record start time only if not already tracking
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }
      // Tick every second
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current !== null) {
          setElapsedTime(formatElapsed(Date.now() - startTimeRef.current));
        }
      }, 1000);
      // Show initial value immediately
      setElapsedTime(formatElapsed(Date.now() - startTimeRef.current));
    } else {
      // Stop ticking but keep the frozen value
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      // Reset start for next run
      if (startTimeRef.current !== null) {
        startTimeRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isRunning]);

  // --- Flow data handler ---
  const handleFlowData = useCallback((flowData: FlowData) => {
    const elementType = flowData.attributes['element-type'];
    const data = flowData.data;

    if (elementType === 'reasoning') {
      console.log('[WorkflowProgress] reasoning');
      setActivityLabel('Reasoning');
    } else if (elementType === 'tool-call') {
      // Tool name available directly from attribute set by backend
      const toolName = flowData.attributes['tool-name'] || 'tool';
      const label = `Using ${toolName}...`;
      console.log('[WorkflowProgress] tool-call:', { toolName, data });
      setActivityLabel(label);
    } else if (elementType === 'tool-result') {
      console.log('[WorkflowProgress] tool-result:', { data });
    } else if (elementType === 'chat') {
      console.log('[WorkflowProgress] chat:', {
        data: typeof data === 'string' ? data.slice(0, 80) : data,
      });
      setActivityLabel('Responding...');
      // Extract status message from chat text
      if (typeof data === 'string' && data.trim()) {
        const lines = data.split('\n').filter((l: string) => l.trim().length > 0);
        const lastLine = lines[lines.length - 1]?.trim();
        if (lastLine) {
          setStatusMessage(lastLine);
        }
      }
    } else if (elementType === 'status') {
      console.log('[WorkflowProgress] status:', { data });
      // Extract token usage from ResultMessage usage data
      if (typeof data === 'object' && data) {
        const obj = data as Record<string, unknown>;
        const usage = obj.usage as Record<string, number> | undefined;
        if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
          console.log('[WorkflowProgress] tokens:', { input: usage.input_tokens, output: usage.output_tokens });
          setTokenUsage({ input: usage.input_tokens, output: usage.output_tokens });
        }
      }
    } else if (elementType === 'data') {
      console.log('[WorkflowProgress] data:', { data });
    } else {
      console.log('[WorkflowProgress] other:', { elementType, data });
    }
  }, []);

  useEffect(() => {
    if (!process) {
      setStatusMessage(null);
      setActivityLabel(null);
      return;
    }

    const unsub = process.on('flow_data', handleFlowData);
    return () => {
      unsub();
    };
  }, [process, handleFlowData]);

  // Clear activity label when process completes (but keep statusMessage and tokenUsage)
  useEffect(() => {
    if (!isRunning) {
      setActivityLabel(null);
    }
  }, [isRunning]);

  return { elapsedTime, statusMessage, activityLabel, tokenUsage };
}
