import type { FlowData } from '@sdk';

/** The typed transcript entry the backend attached to a frame, when present. */
export function transcriptEntry(flowData: FlowData): Record<string, unknown> | null {
  const processEntry = flowData.processEntry;
  if (!processEntry || typeof processEntry !== 'object') return null;
  const entry = (processEntry as { transcript_entry?: unknown }).transcript_entry;
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
}
