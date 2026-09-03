/**
 * ONE rule from a source (or a bare channel) to its glyph name. It used to live
 * twice — on the card and in the inbox's channel attribution — and the
 * attached-channels bar would have been the third copy.
 *
 *   1. the spec's `channel_icon_names[channel]` — a multi-channel transport
 *      (agent) names each channel's glyph, so a Gmail row and a Slack row
 *      don't both read "robot";
 *   2. else the spec's own `icon_name`;
 *   3. else '' — the caller picks its generic fallback (the DataSource type's
 *      registry glyph on a source row; a chat bubble on a source-less origin).
 *
 * A pure function on purpose: the specs are one global query, and whoever
 * already holds the spec passes it in rather than subscribing again.
 */
import type { LucideIcon } from 'lucide-react';
import { DataSource, type DataSourceSpec } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';

type SpecGlyphs = Pick<DataSourceSpec, 'icon_name' | 'channel_icon_names'>;

export function sourceIconName(spec: SpecGlyphs | null | undefined, channel: string | null | undefined): string {
  const byChannel = channel ? spec?.channel_icon_names?.[channel] : undefined;
  return byChannel || spec?.icon_name || '';
}

/** The glyph component for a source row: the rule above, else the type's registry icon. */
export function sourceIcon(spec: SpecGlyphs | null | undefined, channel: string | null | undefined): LucideIcon {
  const name = sourceIconName(spec, channel);
  return name ? lucideByName(name) : iconForType(DataSource.type);
}
