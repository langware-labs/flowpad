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
import type { DestinationLabels, InboundChannel } from './inbound-model';

/** How often the screen re-reads `webhook/mine` while it is open — what moves the live counters. */
export const INBOUND_POLL_MS = 5000;

/**
 * The caller's hub claims, re-read every 5 s while mounted. `openedAt` (epoch seconds) is when the screen opened:
 * the live counters count `recent[]` from there, client-side — nothing is stored.
 */
export function useInboundClaims(api: InboundApi = InboundWebhooks, pollMs: number = INBOUND_POLL_MS) {
  const [claims, setClaims] = useState<InboundClaim[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openedAt = useRef(Date.now() / 1000).current;

  const refresh = useCallback(async () => {
    try {
      setClaims(await api.mine());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const numbers = useMemo(() => inboundTree(claims ?? []), [claims]);
  return { claims, numbers, error, loading: claims === null && error === null, refresh, openedAt };
}

/** This desktop's instance id (null on the hub page, or while it is read). */
export function useHereInstance(api: InboundApi = InboundWebhooks): string | null {
  const [here, setHere] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .here()
      .then((id) => alive && setHere(id))
      .catch(() => alive && setHere(null));
    return () => {
      alive = false;
    };
  }, [api]);
  return here;
}

const agentsQuery = new QueryRequest({ type: Agent.type, scope: [], name: 'inbound:agents' });
const NO_SOURCES: DataSource[] = [];
const NO_AGENTS: Agent[] = [];

/**
 * The message channels on this desktop a claim can deliver to, each with the agent that answers it and that
 * agent's cloud placements holding the same channel. Empty on the hub page: there are no local channels there.
 */
export function useInboundChannels(enabled: boolean): InboundChannel[] {
  const { data: sources = NO_SOURCES } = useEntitiesQuery<DataSource>(sourcesQuery, { enabled });
  const { data: agents = NO_AGENTS } = useEntitiesQuery<Agent>(agentsQuery, { enabled });
  const [rows, setRows] = useState<InboundChannel[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const channels = (await DataSource.channels()).filter((c) => c.source_id);
        const withPlaces = await Promise.all(
          channels.map(async (c) => {
            const source = sources.find((s) => s.id === c.source_id);
            let places: InboundChannel['places'] = [];
            try {
              places = source ? (await source.route()).places : [];
            } catch {
              places = [];
            }
            const owner = source ? ownerOf(source) : null;
            const agent = owner?.startsWith(`${Agent.type}-`)
              ? agents.find((a) => `${Agent.type}-${a.id}` === owner)
              : undefined;
            return { id: c.source_id, name: c.name, provider: c.provider, ownerName: agent?.name, places };
          }),
        );
        if (alive) setRows(withPlaces);
      } catch {
        if (alive) setRows([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, sources, agents]);

  return enabled ? rows : [];
}

/** The hub's own sentence for a refusal, else the error's. */
export function errorText(e: unknown): string {
  const said = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
  return said || (e instanceof Error ? e.message : String(e));
}

/** The HTTP status of a failed call, when it carried one. */
export function errorStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
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
