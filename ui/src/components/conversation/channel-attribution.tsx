import { useCallback } from 'react';
import { MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DataSource, type Conversation } from '@sdk';
import type { IChannelSpec, ICloudOrigin, ICloudOriginLocal } from '@sdk';
import { Badge } from '@src/components/ui/badge';
import { sourceGlyphs, sourceIconName } from '@src/components/data-sources/source-icon';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { cn } from '@src/lib/utils';
import { COMPACT } from './CategoryChips';
import { humanizeType } from '@src/utils/humanize';

/**
 * ONE resolver from a message's channel to its glyph + label, and the compact
 * chip that renders it. The icon comes from the DATA SOURCE SPECS — the same
 * assets the Data Sources screen renders — never from a per-vendor map:
 *
 *   1. `origin_local.data_source_id` → that source's spec (exact — the very
 *      source this message arrived through), else the source whose `channel`
 *      matches `origin.kind`.
 *   2. The spec's `channel_icon_names[kind]` (a multi-channel transport like
 *      `agent` names each channel's glyph), else its `icon_name`.
 *   3. A spec named exactly like the channel (the API `slack` spec), same two
 *      fields.
 *   4. One generic fallback for a channel nothing installed can name.
 *
 * Labels never come from a map either: `humanizeType` renders `gmail` →
 * "Gmail", `google_chat` → "Google Chat", exactly as everywhere else.
 */

// Same global cached queries the Data Sources screen runs — no new fetches.

export interface ChannelAttribution {
  icon: LucideIcon;
  /** Whose way it is, on the channel's mark (Flow on WhatsApp) — the same pair the source's own row shows. */
  badge: LucideIcon | null;
  label: string;
}

export function channelLabel(kind: string | undefined | null): string {
  const key = (kind || '').trim().toLowerCase();
  return key ? humanizeType(key) : '';
}

/**
 * THE resolution rule from a message's origin to its DataSource — the exact
 * pointer (`origin_local.data_source_id`) first, else the source whose
 * `channel` matches `origin.kind`. One copy, shared by the attribution chip
 * and the attention-polling hook: two hand-rolled versions of "which source
 * does this conversation belong to" would drift, and the badge could
 * attribute one source while attention polls a different one.
 */
export function sourceForOrigin(
  sources: DataSource[],
  origin: ICloudOrigin | null | undefined,
  originLocal?: ICloudOriginLocal | null,
): DataSource | undefined {
  if (!origin?.kind) return undefined;
  const kind = origin.kind.trim().toLowerCase();
  return (
    (originLocal?.data_source_id
      ? sources.find((s) => s.id === originLocal.data_source_id)
      : undefined) ?? sources.find((s) => (s.channel || '').trim().toLowerCase() === kind)
  );
}

export function useChannelAttribution() {
  const { specFor } = useSourceSpecs();
  const { data: sources = [] } = useEntitiesQuery<DataSource>(sourcesQuery);

  const attributionFor = useCallback(
    (
      origin: ICloudOrigin | null | undefined,
      originLocal?: ICloudOriginLocal | null,
      channelSpec?: IChannelSpec | null,
    ): ChannelAttribution | null => {
      // The conversation's channel says whether its rows wear a chip — Flowpad's own chat
      // declares none. A hub runtime has no spec and keeps the origin rule.
      if (channelSpec && !channelSpec.chip) return null;
      if (!origin?.kind) return null;
      const kind = origin.kind.trim().toLowerCase();
      const source = sourceForOrigin(sources, origin, originLocal);
      // Source first, like the icon: the driver that delivered the row names it
      // ("Agent Email" — cloud_email stamps the generic `email` kind, which no
      // spec names). Then the kind's own spec ("Help desk", not "Helpdesk");
      // `humanizeType` only for a channel nothing names.
      const sourceSpec = source ? specFor(source.provider) : undefined;
      const kindSpec = specFor(kind);
      // A multi-channel transport (`agent`) names each channel's glyph, and its
      // rows are labelled by that channel too — a Slack row reads "Slack", not
      // "Agent transport".
      const byChannel = !!sourceSpec?.channel_icon_names?.[kind];
      // A driver in a group is one way to that CHANNEL ("Flow — no setup" is a way to WhatsApp): the row names the
      // channel, the group, never the way's own title.
      const label =
        (byChannel ? undefined : sourceSpec?.group || sourceSpec?.title) ||
        kindSpec?.group ||
        kindSpec?.title ||
        channelLabel(kind);
      // The first spec that names a glyph; none: a chat bubble, not the DataSource type's registry glyph.
      const spec = [sourceSpec, kindSpec].find((x) => sourceIconName(x, kind));
      if (!spec) return { icon: MessageSquare, badge: null, label };
      const { Base, Badge } = sourceGlyphs(spec, kind);
      return { icon: Base, badge: Badge, label };
    },
    [sources, specFor],
  );

  /** A whole conversation's channel — what its header names it by, before any message is read. */
  const attributionForConversation = useCallback(
    (conv: Pick<Conversation, 'channel' | 'channel_source_id' | 'channel_spec'>) =>
      conv.channel
        ? attributionFor(
            { kind: conv.channel, namespace: '', key: '', url: null },
            conv.channel_source_id ? { data_source_id: conv.channel_source_id, source_item_id: '' } : null,
            conv.channel_spec,
          )
        : null,
    [attributionFor],
  );

  return { attributionFor, attributionForConversation };
}

// Same compact treatment as CategoryChips — one visual language, no new pill.
// The source chip is the one a row is recognised BY, so its glyph is bigger than
// a category's and keeps its brand colour — the text stays quiet.
const SOURCE_CHIP = cn(COMPACT, 'gap-1 border-border bg-muted ps-1 pe-1.5 py-px text-[10px] font-semibold text-muted-foreground');

/** The per-row source chip: icon + channel, for channels whose spec wears one.
 *  Presentational: the LIST resolves attribution once (`useChannelAttribution`)
 *  and hands each row its answer, so 300 rows do not hold 600 query watchers.
 *  Flowpad's own chat declares `chip: false` and renders nothing.
 *
 *  `iconOnly` drops the label for surfaces too narrow to spend a word on it
 *  (the home brief strip) — same resolver, same glyph, label on hover. */
export function SourceChip({
  attribution,
  className,
  iconOnly,
}: {
  attribution: ChannelAttribution | null;
  className?: string;
  iconOnly?: boolean;
}) {
  if (!attribution) return null;
  const { icon, badge } = attribution;
  if (iconOnly) {
    // The tooltip lives on a WRAPPER, never as a child of the glyph: an icon
    // resolved from a spec asset can render an <img>, and a void element may
    // not take children (a nested <title> crashed the home strip).
    return (
      <span
        className={cn('inline-flex shrink-0 items-center', className)}
        data-chip-type="source"
        title={attribution.label}
        aria-label={attribution.label}
      >
        <IconWithBadge Base={icon} Badge={badge} className="size-3.5 shrink-0 text-muted-foreground" />
      </span>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn(SOURCE_CHIP, className)}
      data-chip-type="source"
      title={attribution.label}
    >
      <IconWithBadge Base={icon} Badge={badge} className="size-4 shrink-0" />
      {attribution.label}
    </Badge>
  );
}
