import { Trans } from '@lingui/react/macro';
import { InboundWebhooks, Project, ViewType, type InboundNumber } from '@sdk';
import { useMemo } from 'react';
import { channelState } from '@src/components/items/item-state';
import { servedPage } from '@src/lib/hub-page-url';
import { DockPointer } from '@src/navigation/DockPointer';
import { useInboundClaims } from '@src/components/inbound/use-inbound';
import { roleOf } from '@src/components/items/role';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useProjects } from '@src/hooks/use-projects';
import { crossCounters } from './axes';
import type { AssetCounterGroup } from './types';

/**
 * Channels and projects as items tabs — the same card, filters and paging as every other kind.
 * A channel opens its Routing page; a project its own page.
 */

const channelName = (n: InboundNumber) => n.claim.provider.charAt(0).toUpperCase() + n.claim.provider.slice(1);

export const channelCounterGroup: AssetCounterGroup<InboundNumber> = {
  id: 'channels',
  type: 'webhook',
  useCounters: () => {
    const { numbers, loading } = useInboundClaims(InboundWebhooks, 0);
    return useMemo(
      () => crossCounters({ label: <Trans>Channels</Trans>, items: numbers, isLoading: loading }),
      [numbers, loading],
    );
  },
  itemKey: (n) => n.claim.id,
  searchText: (n) => [n.claim.provider, n.claim.sender, n.claim.claim?.key].filter(Boolean).join(' '),
  // The channel's own Routing page, by URL, on whichever page this app serves.
  itemPointer: (n) => new DockPointer(ViewType.INBOUND, n.claim.id, undefined, undefined, servedPage()),
  card: (n) => ({
    title: channelName(n),
    sub: n.claim.sender ?? n.claim.claim?.key ?? undefined,
    icon: iconForType('webhook'),
    state: channelState(n.claim.status),
    warning: n.claim.status === 'pending' ? <Trans>Waiting for the code</Trans> : undefined,
    chips: [<Trans key="r">{n.rules.length} rules</Trans>, <Trans key="d">{n.claim.deliveries} delivered</Trans>],
    at: { date: n.claim.proven_at ? new Date(n.claim.proven_at * 1000) : null },
  }),
  columns: [
    { key: 'channel', header: <Trans>Channel</Trans>, cell: (n) => channelName(n), className: 'w-[40%]' },
    { key: 'sender', header: <Trans>Number</Trans>, cell: (n) => n.claim.sender ?? n.claim.claim?.key ?? '' },
    { key: 'rules', header: <Trans>Rules</Trans>, cell: (n) => n.rules.length },
  ],
};

export const projectCounterGroup: AssetCounterGroup<Project> = {
  id: 'projects',
  type: Project.type,
  useCounters: () => {
    const { projects, isLoading } = useProjects();
    return useMemo(
      () => crossCounters({ label: <Trans>Projects</Trans>, items: projects ?? [], isLoading }),
      [projects, isLoading],
    );
  },
  itemKey: (p) => p.id,
  searchText: (p) => p.name ?? '',
  itemPointer: (p) => p.dockPointer,
  role: roleOf,
  card: (p) => ({
    title: p.name,
    icon: iconForType(Project.type),
    role: roleOf(p),
    at: { date: p.updated_date },
  }),
  columns: [
    { key: 'project', header: <Trans>Project</Trans>, cell: (p) => p.name, className: 'w-[60%]' },
    { key: 'updated', header: <Trans>Updated</Trans>, cell: (p) => String(p.updated_date ?? '') },
  ],
};
