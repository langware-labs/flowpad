import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Agent,
  DataSource,
  type InboundApi,
  type InboundClaim,
  InboundWebhooks,
  QueryRequest,
  inboundTree,
} from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useLingui } from '@lingui/react/macro';
import { ownerOf } from '@src/components/stream-inbox-view/channel-owner';
import { sourcesQuery } from '@src/components/data-sources/use-source-specs';
import { errorMessage } from '@src/lib/error-message';
import type { DestinationLabels, InboundChannel } from './inbound-model';

/** How often the screen re-reads `webhook/mine` while it is open and visible — what moves the live counters. */
const INBOUND_POLL_MS = 5000;

/**
 * The caller's hub claims, re-read every 5 s while mounted and the tab is visible. `openedAt` (epoch seconds) is
 * when the screen opened: the live counters count `recent[]` from there, client-side — nothing is stored.
 */
export function useInboundClaims(api: InboundApi = InboundWebhooks, pollMs: number = INBOUND_POLL_MS) {
  const [claims, setClaims] = useState<InboundClaim[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openedAt = useRef(Date.now() / 1000).current;
  const last = useRef('');
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await api.mine();
      // An unchanged answer keeps the same array: nothing downstream re-renders.
      const seen = JSON.stringify(next);
      if (seen !== last.current) {
        last.current = seen;
        setClaims(next);
      }
      setError(null);
    } catch (e) {
      setError(errorMessage(e, String(e)));
    } finally {
      busy.current = false;
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const tick = () => document.visibilityState === 'visible' && void refresh();
    const timer = setInterval(tick, pollMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh, pollMs]);

  const numbers = useMemo(() => inboundTree(claims ?? []), [claims]);
  return { numbers, error, loading: claims === null && error === null, refresh, openedAt };
}

const agentsQuery = new QueryRequest({ type: Agent.type, scope: [], name: 'inbound:agents' });
const NO_SOURCES: DataSource[] = [];
const NO_AGENTS: Agent[] = [];

/** A channel as fetched, before the owning agent's name is put on it. */
type FetchedChannel = Omit<InboundChannel, 'ownerName'> & { owner: string | null };

/**
 * The message channels on this desktop a claim can deliver to, each with the agent that answers it, this
 * computer's instance id and the agent's cloud placements holding the same channel. Empty on the hub page.
 * The channels and their places are fetched once per set of sources; agent names are put on without a request.
 */
export function useInboundChannels(enabled: boolean): InboundChannel[] {
  const { data: sources = NO_SOURCES } = useEntitiesQuery<DataSource>(sourcesQuery, { enabled });
  const { data: agents = NO_AGENTS } = useEntitiesQuery<Agent>(agentsQuery, { enabled });
  const [fetched, setFetched] = useState<FetchedChannel[]>([]);
  const sourceIds = sources.map((s) => s.id).join(',');

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const byId = new Map(sources.map((s) => [s.id, s]));
    void (async () => {
      try {
        const channels = (await DataSource.channels()).filter((c) => c.source_id);
        const rows = await Promise.all(
          channels.map(async (c): Promise<FetchedChannel> => {
            const source = byId.get(c.source_id);
            const places = (source && (await source.route().catch(() => null))?.places) || [];
            return {
              id: c.source_id,
              name: c.name,
              provider: c.channel || c.provider,
              instanceId: places.find((p) => p.key === 'this')?.instance_id,
              places,
              owner: source ? ownerOf(source) : null,
            };
          }),
        );
        if (alive) setFetched(rows);
      } catch {
        if (alive) setFetched([]);
      }
    })();
    return () => {
      alive = false;
    };
    // Keyed by the set of sources, not the query's array identity: a refetch with the same rows fetches nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sourceIds]);

  return useMemo(() => {
    const names = new Map(agents.map((a) => [`${Agent.type}-${a.id}`, a.name]));
    return fetched.map(({ owner, ...c }) => ({ ...c, ownerName: owner ? names.get(owner) : undefined }));
  }, [fetched, agents]);
}

/** The picker's words, localized. */
export function useDestinationLabels(): DestinationLabels {
  const { t } = useLingui();
  return useMemo(
    () => ({
      defaultLabel: t`Default — the number's fallback`,
      defaultDetail: t`No place of its own: it falls through to "everything else"`,
      thisComputer: t`This computer`,
      channel: (name: string) => t`channel ${name}`,
      cloudBox: (place: string) => t`Cloud box ${place}`,
    }),
    [t],
  );
}
