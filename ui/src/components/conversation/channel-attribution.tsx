import { useCallback } from 'react';
import { MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DataSource, QueryRequest } from '@sdk';
import type { ICloudOrigin, ICloudOriginLocal } from '@sdk';
import { Badge } from '@src/components/ui/badge';
import { useSourceSpecs } from '@src/components/data-sources/use-source-specs';
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
const sourcesQuery = new QueryRequest({
  type: DataSource.type,
  scope: [],
  name: 'data-sources:list',
});

export interface ChannelAttribution {
  icon: LucideIcon;
  label: string;
}

export function channelLabel(kind: string | undefined | null): string {
  const key = (kind || '').trim().toLowerCase();
  return key ? humanizeType(key) : '';
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

      const source =
        (originLocal?.data_source_id && sources.find((s) => s.id === originLocal.data_source_id)) ||
        sources.find((s) => (s.channel || '').trim().toLowerCase() === kind);
      const iconName = (spec: { icon_name?: string; channel_icon_names?: Record<string, string> } | undefined) =>
        spec?.channel_icon_names?.[kind] || spec?.icon_name || '';

      const name = iconName(source ? specFor(source.provider) : undefined) || iconName(specFor(kind));
      return { icon: name ? lucideByName(name) : MessageSquare, label };
    },
    [sources, specFor],
  );

  return { attributionFor };
}

// Same compact treatment as CategoryChips — one visual language, no new pill.
const COMPACT = 'gap-0.5 rounded border px-1 py-0 align-middle text-[9px] font-medium leading-tight';
const MUTED_CHIP = 'border-border/60 bg-muted text-muted-foreground';

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
      className={cn(COMPACT, MUTED_CHIP, className)}
      data-chip-type="source"
      title={attribution.label}
    >
      <Icon className="h-2.5 w-2.5" />
      {attribution.label}
    </Badge>
  );
}
