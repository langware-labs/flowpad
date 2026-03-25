import { buildResourceItems, type ProjectResourceListItem } from '@src/components/project-resource-list';
import type { SnifferEvent } from '@src/hooks/use-hooks-sniffer';
import type { ScanProjectResponse } from '@sdk';
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Returns a display title for the session if the event carries one, null otherwise.
 * Currently only UserPromptSubmit events produce a title (the user's prompt text).
 */
function extractTitle(event: SnifferEvent): string | null {
  if (event.event_type !== 'UserPromptSubmit') return null;
  const raw = event.hook_data?.raw_hook_data as Record<string, unknown> | undefined;
  if (!raw) return null;
  for (const key of ['message', 'prompt']) {
    if (typeof raw[key] === 'string' && raw[key]) return raw[key] as string;
  }
  return null;
}

interface Options {
  snifferEvents: SnifferEvent[];
  seedItems: ProjectResourceListItem[];
  fetchProject: (encodedName: string) => Promise<ScanProjectResponse | null>;
}

/**
 * Maintains a cross-project session registry driven by sniffer events.
 *
 * - Seeds from `seedItems` (current project scan) on mount / when seed changes.
 * - Dynamically adds sessions from other projects when sniffer events arrive
 *   with unknown session IDs; parses the transcript_path to get the project
 *   encoded name and fetches that project's sessions.
 * - Sorts by latest sniffer event time desc, falling back to modifiedAt desc.
 */
export function useEventDrivenSessions({ snifferEvents, seedItems, fetchProject }: Options): {
  items: ProjectResourceListItem[];
} {
  // Mutable refs — mutated freely, trigger re-render via recomputeItems
  const registryRef = useRef(new Map<string, ProjectResourceListItem>());
  const eventLatestRef = useRef(new Map<string, number>());
  const fetchedProjectsRef = useRef(new Set<string>());

  const [items, setItems] = useState<ProjectResourceListItem[]>([]);

  const recomputeItems = useCallback(() => {
    const registry = registryRef.current;
    const eventLatest = eventLatestRef.current;
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const sorted = Array.from(registry.values())
      .filter((item) => {
        // Keep if it has received a sniffer event this session
        if (item.sessionId && eventLatest.has(item.sessionId)) return true;
        // Keep if the process is still running
        if (item.status === 'running') return true;
        // Keep if active within the last 3 hours
        const modifiedMs = item.modifiedAt ? new Date(item.modifiedAt).getTime() : 0;
        if (modifiedMs > Date.now() - THREE_HOURS_MS) return true;
        return false;
      })
      .sort((a, b) => {
        const aTime = (a.sessionId ? (eventLatest.get(a.sessionId) ?? 0) : 0);
        const bTime = (b.sessionId ? (eventLatest.get(b.sessionId) ?? 0) : 0);
        if (bTime !== aTime) return bTime - aTime;
        const aMs = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0;
        const bMs = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0;
        return bMs - aMs;
      });
    startTransition(() => setItems(sorted));
  }, []);

  // Seed from current project items; never overwrite entries already in registry
  useEffect(() => {
    const registry = registryRef.current;
    let changed = false;
    for (const item of seedItems) {
      if (item.sessionId && !registry.has(item.sessionId)) {
        registry.set(item.sessionId, item);
        changed = true;
      }
    }
    if (changed) recomputeItems();
  }, [seedItems, recomputeItems]);

  // React to sniffer events: update timestamps and discover new sessions
  useEffect(() => {
    if (!snifferEvents.length) return;
    const registry = registryRef.current;
    const eventLatest = eventLatestRef.current;
    const fetchedProjects = fetchedProjectsRef.current;

    // encodedName → true for projects we need to fetch in this batch
    const toFetch = new Set<string>();
    let latestChanged = false;

    for (const event of snifferEvents) {
      const sid = event.session_id;
      if (!sid) continue;

      const ts = new Date(event.timestamp).getTime();
      if (!Number.isNaN(ts) && ts > (eventLatest.get(sid) ?? 0)) {
        eventLatest.set(sid, ts);
        latestChanged = true;
      }

      const title = extractTitle(event);

      if (!registry.has(sid)) {
        // Immediately register a minimal item from the sniffer event so the
        // session appears in the list without waiting for a project scan.
        const encodedName = event.transcript_path?.split('/projects/')[1]?.split('/')[0];
        registry.set(sid, {
          id: sid,
          name: title ?? sid,
          type: 'claude_session',
          sessionId: sid,
          projectEncodedName: encodedName,
          sessionPath: event.transcript_path ?? undefined,
          path: event.hook_data?.cwd ?? undefined,
          modifiedAt: event.timestamp,
        });
        latestChanged = true;
        // Also queue a project fetch to enrich with metadata (messageCount, status, slug name)
        if (encodedName && !fetchedProjects.has(encodedName)) {
          toFetch.add(encodedName);
        }
      } else if (title !== null) {
        // Update the displayed name to the latest user prompt for this session
        const existing = registry.get(sid)!;
        registry.set(sid, { ...existing, name: title });
        latestChanged = true;
      }
    }

    if (latestChanged) recomputeItems();

    for (const encodedName of toFetch) {
      fetchedProjects.add(encodedName);
      void fetchProject(encodedName)
        .then((response) => {
          if (!response) return;
          const newItems = buildResourceItems(response).filter((i) => i.type === 'claude_session');
          for (const item of newItems) {
            // Overwrite minimal sniffer-derived entry with enriched scan data
            if (item.sessionId) registry.set(item.sessionId, item);
          }
          recomputeItems();
        })
        .catch((err) => {
          console.error('[useEventDrivenSessions] Failed to fetch project:', encodedName, err);
          // Allow retry on next event batch
          fetchedProjects.delete(encodedName);
        });
    }
  }, [snifferEvents, fetchProject, recomputeItems]);

  return { items };
}
