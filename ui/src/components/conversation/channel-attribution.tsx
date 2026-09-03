import { useCallback } from 'react';
import { MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DataSource } from '@sdk';
import type { ICloudOrigin, ICloudOriginLocal } from '@sdk';
import { Badge } from '@src/components/ui/badge';
import { sourceIconName } from '@src/components/data-sources/source-icon';
import { sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { lucideByName } from '@src/lib/lucide-by-name';
import { cn } from '@src/lib/utils';
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
    ): ChannelAttribution | null => {
      if (!origin?.kind) return null;
      const kind = origin.kind.trim().toLowerCase();
      const label = channelLabel(kind);

      const source = sourceForOrigin(sources, origin, originLocal);
      const name =
        sourceIconName(source ? specFor(source.provider) : undefined, kind) || sourceIconName(specFor(kind), kind);
      return { icon: name ? lucideByName(name) : MessageSquare, label };
    },
    [sources, specFor],
  );

  return { attributionFor };
}

// Same compact treatment as CategoryChips — one visual language, no new pill.
const COMPACT = 'gap-0.5 rounded border px-1 py-0 align-middle text-[9px] font-medium leading-tight';
// The source chip is the one a row is recognised BY, so its glyph is bigger than
// a category's and keeps its brand colour — the text stays quiet.
const SOURCE_CHIP = 'gap-1 rounded border border-border/60 bg-muted px-1 py-0 align-middle text-[10px] font-medium leading-tight text-muted-foreground';

/** The per-row source chip: icon + channel, only for channel conversations.
 *  Hub-native rows pass no origin and render nothing — absence means "ours". */
export function SourceChip({
  origin,
  originLocal,
  className,
}: {
  origin: ICloudOrigin | null | undefined;
  originLocal?: ICloudOriginLocal | null;
  className?: string;
}) {
  const { attributionFor } = useChannelAttribution();
  const attribution = attributionFor(origin, originLocal);
  if (!attribution) return null;
  const Icon = attribution.icon;
  return (
    <Badge
      variant="outline"
      className={cn(SOURCE_CHIP, className)}
      data-chip-type="source"
      title={attribution.label}
    >
      <Icon className="size-4 shrink-0" />
      {attribution.label}
    </Badge>
  );
}
