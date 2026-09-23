import { useCallback, useEffect, useRef, useState } from 'react';
import { DEPLOYMENT_TIMELINE_TAG, type Deployment, type TimelineEvent } from '@sdk';
import { useOnTag } from '@sdk/react/hooks';

const PAGE = 60;

/**
 * A deployment's timeline (`Deployment.timeline`), newest first, read again whenever the
 * deployment says it moved — its process emits `deployment.timeline` (a message in, a turn
 * started, a sender refused), relayed to the app — and when a reply lands on one of its channels
 * (the channel's own `message.projected`). Older pages come by `loadOlder`.
 */
export function useDeploymentTimeline(deployment: Deployment | null | undefined) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const older = useRef<TimelineEvent[]>([]);
  const deploymentId = deployment?.id ?? null;

  // One read at a time, and none lost: a request that lands while one is in flight reads again
  // after it — that read may have left before the fact that asked for this one was written.
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const readOnce = useCallback(async () => {
    if (!deployment) return;
    try {
      const page = await deployment.timeline({ limit: PAGE });
      // Keep the older pages already loaded: a reread only refreshes the head.
      const head = page.events;
      const oldest = head.length ? head[head.length - 1].at : null;
      const tail = oldest ? older.current.filter((e) => e.at < oldest) : [];
      setEvents([...head, ...tail]);
      if (!older.current.length) setBefore(page.before);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [deployment]);

  // The loop calls the LATEST reader: one captured when the read began may predate the deployment.
  const latest = useRef(readOnce);
  latest.current = readOnce;

  const read = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    inFlight.current = (async () => {
      do {
        again.current = false;
        await latest.current();
      } while (again.current);
    })().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  }, []);

  useEffect(() => {
    older.current = [];
    setEvents(null);
    void read();
  }, [deploymentId, readOnce, read]);

  useOnTag(DEPLOYMENT_TIMELINE_TAG, (event) => {
    if ((event.data as { deployment_id?: string } | undefined)?.deployment_id === deploymentId) void read();
  });
  // A reply lands as a message placed on the channel it answered — its own announcement.
  const sources = new Set((events ?? []).map((e) => e.data_source_id).filter(Boolean));
  useOnTag('stream_inbox.*.message.projected', (event) => {
    const source = (event.data as { source_id?: string } | undefined)?.source_id;
    if (source && sources.has(source)) void read();
  });

  const loadOlder = useCallback(async () => {
    if (!deployment || !before) return;
    const page = await deployment.timeline({ limit: PAGE, before });
    older.current = [...older.current, ...page.events];
    setEvents((current) => [...(current ?? []), ...page.events]);
    setBefore(page.before);
  }, [deployment, before]);

  return { events, error, hasOlder: !!before, loadOlder, reload: read };
}
