import { useCallback, useEffect, useRef, useState } from 'react';
import { DEPLOYMENT_TIMELINE_TAG, type Deployment, type DeploymentThread, type TimelineEvent } from '@sdk';
import { useOnTag } from '@sdk/react/hooks';

type Data = Record<string, unknown> | undefined;

/**
 * A value read from the backend and read again when told to — one read at a time, none lost: a
 * request that lands while one is in flight reads again after it (that read may have left before the
 * fact that asked for this one was written). The loop calls the LATEST reader.
 */
function useLiveRead<T>(read: (() => Promise<T>) | null, key: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(read);
  latest.current = read;
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const reload = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    inFlight.current = (async () => {
      do {
        again.current = false;
        const reader = latest.current;
        if (!reader) return;
        try {
          setData(await reader());
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } while (again.current);
    })().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  }, []);

  useEffect(() => {
    setData(null);
    if (key) void reload();
  }, [key, reload]);

  return { data, error, reload };
}

/**
 * The conversations a deployment holds (`Deployment.threads`), the active ones first, each with its
 * status now — read again whenever the deployment says it moved (`deployment.timeline`), a message is
 * placed (a reply, a call's line — a NEW call comes from no known thread, so any placement counts), or
 * one of its processes changes state (`agent.status`: working → idle).
 */
export function useDeploymentThreads(deployment: Deployment | null | undefined) {
  const id = deployment?.id ?? null;
  const { data, error, reload } = useLiveRead<DeploymentThread[]>(deployment ? () => deployment.threads() : null, id);
  const processes = new Set((data ?? []).map((t) => t.process_id).filter(Boolean));

  useOnTag(DEPLOYMENT_TIMELINE_TAG, (event) => {
    if ((event.data as Data)?.deployment_id === id) void reload();
  });
  useOnTag('stream_inbox.*.message.projected', () => void reload());
  useOnTag('agent.status', (event) => {
    const processId = String(event.target ?? '').split(':')[1] ?? '';
    if (processes.has(processId)) void reload();
  });
  return { threads: data, error };
}

/**
 * One thread's events (`Deployment.timeline` narrowed to its conversation), newest first — read again
 * when the deployment moves, a message lands on its channel, or its process changes state.
 */
export function useThreadEvents(deployment: Deployment | null | undefined, thread: DeploymentThread | null) {
  const conversation = thread?.conversation_id ?? null;
  const { data, error, reload } = useLiveRead<TimelineEvent[]>(
    deployment && conversation ? async () => (await deployment.timeline({ conversation, limit: 200 })).events : null,
    deployment && conversation ? `${deployment.id}:${conversation}` : null,
  );

  useOnTag(DEPLOYMENT_TIMELINE_TAG, (event) => {
    if ((event.data as Data)?.deployment_id === deployment?.id) void reload();
  });
  useOnTag('stream_inbox.*.message.projected', (event) => {
    if ((event.data as Data)?.source_id === thread?.data_source_id) void reload();
  });
  useOnTag('agent.status', (event) => {
    if (thread?.process_id && String(event.target ?? '').endsWith(thread.process_id)) void reload();
  });
  return { events: data, error };
}
