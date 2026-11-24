import { useCallback, useMemo } from 'react';
import { DataSource, DataDriver, Project, QueryRequest, TypeId } from '@sdk';
import type { DriverOffer } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { sourceIconName } from './source-icon';

/** The configured sources — ONE named query, shared by DataSourcesView and the
 *  stream inbox's channel attribution, so the cached result and any future shape
 *  change stay in step between them. Global for the reason stated below. */
export const sourcesQuery = new QueryRequest({
  type: DataSource.type,
  scope: [],
  name: 'data-sources:list',
});

/** One project's sources — what Project Home lists. */
export const projectSourcesQuery = (projectId: string) =>
  new QueryRequest({
    type: DataSource.type,
    scope: [new TypeId(Project.type, projectId)],
    name: `project-data-sources:${projectId}`,
  });

/**
 * The installed source definitions, and a lookup by name.
 *
 * Global by construction (`scope: []`) for the same reason `DataSource` is: a
 * definition is a property of the instance, not of a project, and switching
 * project must not change which sources exist.
 *
 * This is what replaced the hardcoded provider catalog. The dialog now renders
 * whatever is installed, so adding a source is an asset — not a frontend release.
 */
const specsQuery = new QueryRequest({
  type: DataDriver.type,
  scope: [],
  name: 'data-sources:specs',
});

/** Stable while loading — a fresh `[]` per render would change `specFor`'s
 *  identity and re-trigger the dialog effect that depends on it. */
const EMPTY: DataDriver[] = [];

export function useSourceSpecs(options?: { enabled?: boolean }) {
  const { data: specs = EMPTY, isLoading: loading } = useEntitiesQuery<DataDriver>(specsQuery, options);
  // `name` is the registry key AND the folder name AND the asset id — one noun,
  // so a lookup needs nothing else.
  const byName = useMemo(() => new Map(specs.map((s) => [s.name, s])), [specs]);
  const specFor = useCallback((provider: string) => byName.get(provider), [byName]);
  return { specs, specFor, loading };
}

/** A MessageSource's spec: its driver can push a reply back (`IngestDriver.sends`).
 *  The one client-side spelling of `agent_scope.is_message_source`'s driver half. */
export const isMessageDriverSpec = (spec: DataDriver | undefined | null): boolean => !!spec?.sends;

/** A message channel: on a channel, its driver can send, and it is not read-only.
 *  The client spelling of `agent_scope.is_message_source` — keep the two identical. */
export const isMessageChannel = (
  source: Pick<DataSource, 'read_only' | 'channel'>,
  spec: DataDriver | undefined | null,
): boolean => !source.read_only && !!(source.channel || '').trim() && isMessageDriverSpec(spec);

/** The record-kind prefix of a driver the application makes for its own plumbing (a deployment's chat
 *  endpoint): the loop answers it, but no list names it as one of the owner's channels. */
export const INTERNAL_KIND_PREFIX = 'datasource.internal.';

/** A message channel a person is SHOWN: `isMessageChannel` minus the internal drivers. The loop still
 *  answers those (`agent_scope.is_message_source` is unchanged); only the lists leave them out. */
export const isListedChannel = (
  source: Pick<DataSource, 'read_only' | 'channel'>,
  spec: DataDriver | undefined | null,
): boolean => isMessageChannel(source, spec) && !(spec?.kind ?? '').startsWith(INTERNAL_KIND_PREFIX);

/** Everything that is not a message channel is a knowledge source (data source). */
export const isKnowledgeSource = (
  source: Pick<DataSource, 'read_only' | 'channel'>,
  spec: DataDriver | undefined | null,
): boolean => !isMessageChannel(source, spec);

/** A driver whose items are files (the `object` family): its page shows those files. */
export const isObjectDriverSpec = (spec: DataDriver | undefined | null): boolean => spec?.family === 'object';

/** A group's members, in their declared order (``group_order``, then title). */
export function groupMembers(specs: DataDriver[], group: string): DataDriver[] {
  return specs
    .filter((s) => s.group === group)
    .sort((a, b) => (a.group_order ?? 0) - (b.group_order ?? 0) || (a.title || '').localeCompare(b.title || ''));
}

/** The glyph name of a group's tile: the group's own, declared by any member (first in group order). */
const groupIconName = (specs: DataDriver[], group: string): string =>
  groupMembers(specs, group).find((m) => m.group_icon_name)?.group_icon_name || '';

/** The providers a person may add: an unlisted one is never offered (a vendor the cloud stands in front of),
 *  and one the cloud provisions is an agent's own account — offered only when adding for an agent. */
export const offeredSpecs = (specs: DataDriver[], forAgent: boolean): DataDriver[] =>
  specs.filter((s) => s.listed && (!s.provisioned || forAgent));

/** One choice a person makes when adding a source: a group ("Slack") or a driver on its own. */
export interface SourceChoice {
  /** The group, else the driver's name. */
  key: string;
  label: string;
  /** The group's own glyph for a group, else the driver's. */
  iconName: string;
  /** A corner badge on that glyph, when the driver badges this channel. */
  badgeName?: string;
  /** What picking it opens on: the group's first member stands for the group. */
  spec: DataDriver;
  /** Set when the choice is one channel a driver offers (`DataDriver.offers`), not the driver itself. */
  offer?: DriverOffer;
}

/** The offer a source of `spec` was made from: the one whose every preset value its config holds. */
export const offerOf = (
  spec: DataDriver | undefined,
  config: Record<string, string | undefined>,
): DriverOffer | undefined =>
  spec?.offers?.find((o) => {
    const preset = Object.entries(o.preset ?? {});
    return preset.length > 0 && preset.every(([key, value]) => (config[key] ?? '') === value);
  });

export const choiceKey = (s: DataDriver): string => s.group || s.name || '';

/** The choices among `specs`, one per group, plus one per channel a driver offers on its own. The add
 *  dialog's tiles and a stream inbox's default channels are both this list, so a mark and the tile it
 *  opens cannot disagree. */
export function sourceChoices(specs: DataDriver[]): SourceChoice[] {
  const drivers = specs
    .filter((s) => !s.group || groupMembers(specs, s.group)[0]?.name === s.name)
    .map((spec) => ({
      key: choiceKey(spec),
      label: spec.group || spec.title || spec.name || '',
      iconName: (spec.group && groupIconName(specs, spec.group)) || sourceIconName(spec, null),
      spec,
    }));
  const offers = specs.flatMap((spec) =>
    (spec.offers ?? []).map((offer) => ({
      key: `${spec.name}:${offer.key}`,
      label: offer.title,
      iconName: sourceIconName(spec, offer.channel),
      badgeName: spec.channel_badge_icon_names?.[offer.channel ?? ''],
      spec,
      offer,
    })),
  );
  return [...drivers, ...offers];
}

/** The message channels a person may add — every offered message driver whose group declares `featured`,
 *  one per group: what an empty stream inbox offers under "Add a message channel". */
export const messageChannelChoices = (specs: DataDriver[], forAgent: boolean): SourceChoice[] => {
  const offered = offeredSpecs(specs, forAgent).filter(isMessageDriverSpec);
  const featured = new Set(offered.filter((s) => s.featured).map(choiceKey));
  return sourceChoices(offered)
    .filter((c) => (c.offer ? c.offer.featured : featured.has(c.key)))
    .sort((a, b) => a.label.localeCompare(b.label));
};

/** A channel still to connect, as a stream inbox draws it by default. */
export type ChannelOffer = SourceChoice;

/** The channels a stream inbox draws by default for an owner who has connected none of them: every
 *  offered message driver that declares `featured` (one per group). Empty once the owner has a source of
 *  ANY featured channel, whatever its status — from then on the + button is the way to more. */
export function channelOffers(
  specs: DataDriver[],
  rows: Pick<DataSource, 'provider'>[],
  forAgent: boolean,
): ChannelOffer[] {
  const choices = messageChannelChoices(specs, forAgent);
  const featured = new Set(choices.map((c) => c.key));
  const connected = new Set(rows.map((r) => r.provider));
  return specs.some((s) => connected.has(s.name ?? '') && featured.has(choiceKey(s))) ? [] : choices;
}
