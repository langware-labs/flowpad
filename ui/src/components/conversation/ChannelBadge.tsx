import { isAddressable, type ICloudOrigin } from '@sdk';
import { useChannelAttribution } from './channel-attribution';

export { channelLabel } from './channel-attribution';

/**
 * The channel mark on a message that CACHES a cloud record.
 *
 * The rule is `origin === null → nothing`, so a Flowpad-native message is
 * unmarked by construction — no flag to keep in sync, no backfill.
 *
 * The glyph is spec-resolved (`useChannelAttribution`): the same
 * `data_source_spec` assets the Data Sources screen renders name every
 * channel's icon, so Slack shows one mark everywhere and a new channel needs
 * no frontend release — there is deliberately NO per-vendor map here.
 */
export function ChannelBadge({ origin }: { origin: ICloudOrigin | null | undefined }) {
  const { attributionFor } = useChannelAttribution();
  // Internal messages get no icon — the whole point of `origin` being nullable.
  const attribution = attributionFor(origin);
  if (!attribution) return null;

  const { icon: Icon, label } = attribution;
  const openable = isAddressable(origin);

  // Openable origins are a link; the rest is the same pill, inert. Rendering
  // an <a> with no href would be a lie the keyboard notices.
  const body = (
    <>
      <Icon className="h-3 w-3" />
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
      href={origin!.url}
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
