import { ExternalLink, Mail, MessageSquare, Sparkles, SquareKanban } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { isAddressable, type ICloudOrigin } from '@sdk';
import { providerMark } from '@src/components/connections-manager/provider-marks';
import { humanizeType } from '@src/utils/humanize';

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
 * second copy of the same SVG. ONE entry per channel — two parallel maps
 * drift, and a channel added to only one renders half-labelled.
 */
const CHANNELS: Record<string, { icon: LucideIcon; label: string }> = {
  gmail: { icon: Mail, label: 'Gmail' },
  email: { icon: Mail, label: 'Email' },
  slack: { icon: MessageSquare, label: 'Slack' },
  jira: { icon: SquareKanban, label: 'Jira' },
  notion: { icon: Sparkles, label: 'Notion' },
};

export function channelLabel(kind: string | undefined): string {
  const key = (kind || '').trim().toLowerCase();
  // `humanizeType` is the app's title-caser and handles `[-_]`, so an
  // uncurated `google_chat` reads "Google Chat" here exactly as it does
  // everywhere else — a local capitalise would render "Google_chat".
  return CHANNELS[key]?.label ?? (key ? humanizeType(key) : '');
}

export function ChannelBadge({ origin }: { origin: ICloudOrigin | null | undefined }) {
  // Internal messages get no icon — the whole point of `origin` being nullable.
  if (!origin?.kind) return null;

  const kind = origin.kind.trim().toLowerCase();
  const Mark = providerMark(kind);
  const Icon = CHANNELS[kind]?.icon;
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


/**
 * Why this conversation cannot be replied to from here — yet.
 *
 * A conversation whose messages carry an `origin` is a CACHE of a cloud thread.
 * Until the channel's send verb ships, a reply typed here would become an
 * ordinary Flowpad message that the actual recipient never sees, so the
 * composer is gated and this says so, with a way out to the real thread.
 */
export function ChannelReplyNotice({ origin }: { origin: ICloudOrigin | null | undefined }) {
  if (!origin?.kind) return null;
  const label = channelLabel(origin.kind);
  return (
    <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
      <Trans>Replying in {label} is not available here yet.</Trans>
      {isAddressable(origin) && (
        <a
          href={origin.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-sky-600 underline-offset-2 hover:underline dark:text-sky-400"
        >
          <ExternalLink className="h-3 w-3" />
          <Trans>Open in {label}</Trans>
        </a>
      )}
    </p>
  );
}
