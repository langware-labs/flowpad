/**
 * The backend's event-bus inspection routes (`flow_sdk/server/routes/debug.py`),
 * wrapped once. The UI never calls these paths itself — this module is the only
 * place they are spelled.
 */
import apiClient from '../client';
import type { FlowEvent } from './EventBus';

export interface RecentEvents {
  events: FlowEvent[];
  count: number;
  cap: number;
  /** The tag patterns the backend forwards to the app (only these reach the ring). */
  patterns: string[];
}

export interface ObservedTag {
  count: number;
  first_ts?: string | null;
  last_ts?: string | null;
  last_target?: string | null;
}

/** The last events the backend forwarded to the app, oldest first. */
export async function recentBusEvents(): Promise<RecentEvents> {
  const data = (await apiClient.get('/debug/recent_events')) as RecentEvents | null;
  return data ?? { events: [], count: 0, cap: 0, patterns: [] };
}

/** Every tag seen on the bus since boot, with counts. */
export async function observedBusTags(): Promise<Record<string, ObservedTag>> {
  const data = (await apiClient.get('/debug/observed_tags')) as { observed?: Record<string, ObservedTag> } | null;
  return data?.observed ?? {};
}

/** Put an event on the bus by hand. Answers the envelope, or null when nothing listens. */
export async function emitBusEvent(tag: string, target: string, data: Record<string, unknown> = {}): Promise<FlowEvent | null> {
  return (await apiClient.post('/debug/emit_tag', { tag, target, data })) as FlowEvent | null;
}
