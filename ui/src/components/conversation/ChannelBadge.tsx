import { ExternalLink, Mail, MessageSquare, Sparkles, SquareKanban } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isAddressable, type ICloudOrigin } from '@sdk';
import { providerMark } from '@src/components/connections-manager/provider-marks';

/**
 * The channel mark on a message that CACHES a cloud record.
 *
 * The rule is `origin === null → nothing`, so a Flowpad-native message is
 * unmarked by construction — no flag to keep in sync, no backfill.
 *
 * ONE map, keyed by `origin.kind` (the channel). Per the type-icon rule a
 * glyph never belongs at a call site; entity icons come from the backend
 * registry, but a channel is not an entity type and brand marks are not
 * `currentColor` glyphs, so this is the registry for that axis. Slack's real
 * four-colour mark comes from the existing `providerMark` table rather than a
 * second copy of the same SVG.
 */
const FALLBACK: Record<string, LucideIcon> = {
  gmail: Mail,
  email: Mail,
  slack: MessageSquare,
  jira: SquareKanban,
  notion: Sparkles,
};

const LABEL: Record<string, string> = {
  gmail: 'Gmail',
  email: 'Email',
  slack: 'Slack',
  jira: 'Jira',
  notion: 'Notion',
};

export function channelLabel(kind: string | undefined): string {
  const key = (kind || '').trim().toLowerCase();
  return LABEL[key] ?? (key ? key[0].toUpperCase() + key.slice(1) : '');
}

export function ChannelBadge({ origin }: { origin: ICloudOrigin | null | undefined }) {
  // Internal messages get no icon — the whole point of `origin` being nullable.
  if (!origin?.kind) return null;

  const kind = origin.kind.trim().toLowerCase();
  const Mark = providerMark(kind);
  const Icon = FALLBACK[kind];
  const label = channelLabel(kind);
  const openable = isAddressable(origin);

  const glyph = Mark ? (
    <Mark className="h-3 w-3" />
  ) : Icon ? (
    <Icon className="h-3 w-3" />
  ) : (
    <ExternalLink className="h-3 w-3" />
  );

  // Openable origins are a link; the rest is the same pill, inert. Rendering
  // an <a> with no href would be a lie the keyboard notices.
  const body = (
    <>
      {glyph}
      <span className="font-medium">{label}</span>
    </>
  );
  const className =
    'inline-flex items-center gap-1 rounded-full border border-border/60 px-1.5 py-0 text-[9.5px] text-muted-foreground';

  if (!openable) {
    return (
      <span className={className} data-testid="channel-badge" title={label}>
        {body}
      </span>
    );
  }
  return (
    <a
      href={origin.url}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="channel-badge"
      title={`Open in ${label}`}
      className={`${className} transition-colors hover:border-foreground/40 hover:text-foreground`}
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </a>
  );
}
