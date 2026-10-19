/**
 * The Inbound screen's pure half: which places a claim can be pointed at, and how a claim's place reads.
 * Nothing here calls anything — the hooks gather the inputs, the components render the answers.
 */
import type { ChannelRoutePlace, ChannelRouteTarget, InboundClaim } from '@sdk';

/** One message channel a claim can deliver to, as the screen gathered it. */
export interface InboundChannel {
  /** The channel's DataSource id — what a target's `data_source_id` names. */
  id: string;
  name: string;
  provider: string;
  /** Who answers it (the owning agent's name), when known. */
  ownerName?: string;
  /** The agent's cloud placements that hold this channel (`DataSource.route()` places with a node). */
  places?: ChannelRoutePlace[];
}

/** One choice in the destination picker. */
export interface DestinationOption {
  key: string;
  label: string;
  detail: string;
  target: ChannelRouteTarget;
  testId: string;
}

export interface DestinationLabels {
  defaultLabel: string;
  defaultDetail: string;
  thisComputer: string;
  channel: (name: string) => string;
  cloudBox: (place: string) => string;
}

/**
 * Every place a claim of `provider` can go: the default (no place of its own — the number's fallback), this
 * computer's channels (desktop only: `instanceId` is null on the hub page), and each channel's cloud placements.
 */
export function destinationOptions(
  provider: string,
  channels: InboundChannel[],
  instanceId: string | null,
  labels: DestinationLabels,
  { withDefault = true }: { withDefault?: boolean } = {},
): DestinationOption[] {
  const out: DestinationOption[] = [];
  if (withDefault) {
    out.push({
      key: 'default',
      label: labels.defaultLabel,
      detail: labels.defaultDetail,
      target: { kind: 'none' },
      testId: 'inbound-dest-default',
    });
  }
  for (const ch of channels.filter((c) => c.provider === provider)) {
    const who = ch.ownerName || ch.name;
    if (instanceId) {
      out.push({
        key: `this:${ch.id}`,
        label: `${who} · ${labels.thisComputer}`,
        detail: `${labels.thisComputer} · ${labels.channel(ch.name)}`,
        target: { kind: 'desktop', instance_id: instanceId, data_source_id: ch.id },
        testId: `inbound-dest-this-${ch.id}`,
      });
    }
    for (const place of ch.places ?? []) {
      if (!place.node_typeid) continue;
      out.push({
        key: `node:${place.key}:${ch.id}`,
        label: `${who} · ${place.label}`,
        detail: `${labels.cloudBox(place.label)} · ${labels.channel(ch.name)}`,
        target: { kind: 'node', node_typeid: place.node_typeid, data_source_id: ch.id },
        testId: `inbound-dest-node-${place.key}-${ch.id}`,
      });
    }
  }
  return out;
}

/** Whether two targets name the same place (the hub's `same_place`). */
export function samePlace(a: ChannelRouteTarget | undefined, b: ChannelRouteTarget | undefined): boolean {
  const ka = a?.kind ?? 'none';
  const kb = b?.kind ?? 'none';
  if (ka !== kb) return false;
  if (ka === 'none') return true;
  return (
    (a?.instance_id ?? '') === (b?.instance_id ?? '') &&
    (a?.node_typeid ?? '') === (b?.node_typeid ?? '') &&
    (a?.data_source_id ?? '') === (b?.data_source_id ?? '')
  );
}

/** The picker option a claim's target is, or null when it is a place this screen did not list. */
export function optionFor(
  target: ChannelRouteTarget | undefined,
  options: DestinationOption[],
): DestinationOption | null {
  return options.find((o) => samePlace(o.target, target)) ?? null;
}

/** A place typed by hand: `instance` (a desktop instance id) or `node` (a compute node typeid), and a channel id. */
export function manualTarget(kind: 'desktop' | 'node', where: string, channelId: string): ChannelRouteTarget | null {
  const w = where.trim();
  const c = channelId.trim();
  if (!w || !c) return null;
  if (kind === 'node') {
    return { kind: 'node', node_typeid: w.startsWith('compute_node-') ? w : `compute_node-${w}`, data_source_id: c };
  }
  return { kind: 'desktop', instance_id: w, data_source_id: c };
}

/** The vendor's own name for a claim's key: a group id, a sender's number. */
export function claimTitle(claim: InboundClaim): string {
  if (claim.claim?.kind === 'user') return claim.sender || claim.claim.key || '';
  return claim.claim?.key ?? '';
}

/** The "HH:MM" a live counter counts from. */
export function clockTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The vendors the hub chains, in the order the screen offers them. */
export const INBOUND_PROVIDERS = ['whatsapp', 'telegram', 'slack'] as const;
export type InboundProvider = (typeof INBOUND_PROVIDERS)[number];

export const PROVIDER_TITLE: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', slack: 'Slack' };
