import type { EventLayer } from '@src/hooks/use-hooks-sniffer';
import type { FlowData } from '@sdk';
import { FlowDataSource } from '@sdk';

export type { EventLayer };

/**
 * Renderer-friendly trace event consumed by the InteractiveTerminal trace
 * gutter and the workflow trace gutter. Vendor-neutral — it carries the
 * underlying `FlowData.source` (a `FlowDataSource` enum value) directly, so
 * downstream renderers can color/icon by source without touching any
 * vendor-specific (Claude/Codex) shape.
 */
export interface TraceEvent {
  id: string;
  idx?: number;
  timestamp: string;
  source: FlowDataSource;
  session_id: string;
  event_type: string;
  /** FlowData element-type for events sourced from the unified per-process stream. */
  element_type?: string;
  summary?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  absRow?: number;
  raw: Record<string, any>;
  /** FlowData attributes (sniffer hook subtype, tool-name, webhook-type, etc.). */
  attributes?: Record<string, string>;
  transcript_path?: string;
  webhook_type?: string;
  hook_data?: Record<string, any>;
  layer?: EventLayer;
  warning?: string;
  error?: string;
  /** Pre-computed transcript lens pointer. Null when not derivable. */
  transcriptDockPointer: { ref: string; options: Record<string, string> } | null;
  /** Pre-computed trigger log lens pointer. Null for events without a hook_entry_id. */
  triggerLogDockPointer: { ref: string; options: Record<string, string> } | null;
}

/**
 * Map a `FlowData` from `AgenticProcess.flowDataStream` to a `TraceEvent`.
 * The unified path used by the InteractiveTerminal gutter — vendor-blind.
 */
export function mapFlowDataToTraceEvent(
  fd: FlowData,
  sessionId: string,
): TraceEvent {
  const attributes = fd.attributes ?? {};
  const elementType = fd.elementType;
  const subtype = attributes['subtype'] || '';
  const toolName = attributes['tool-name'] || undefined;
  const webhookType = attributes['webhook-type'] || undefined;
  const transcriptPath = attributes['transcript-path'] || undefined;

  // Choose a discriminator that matches what the renderer expects.
  // For sniffer events the subtype carries the hook event name; for
  // everything else, the element-type is the most specific kind we have.
  const eventType = subtype || toolName || elementType || 'event';

  const raw: Record<string, any> =
    fd.data && typeof fd.data === 'object'
      ? (fd.data as Record<string, any>)
      : { value: fd.data };

  return {
    id: `flowdata-${fd.index}-${fd.timestamp}`,
    timestamp: fd.timestamp,
    source: fd.source,
    session_id: sessionId,
    event_type: eventType,
    element_type: elementType,
    tool_name: toolName,
    raw,
    attributes,
    transcript_path: transcriptPath,
    webhook_type: webhookType,
    warning: fd.warning ?? undefined,
    error: fd.error_text ?? undefined,
    transcriptDockPointer: null,
    triggerLogDockPointer: null,
  };
}
