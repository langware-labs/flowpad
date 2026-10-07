import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ChannelRoute, DataSource } from '@sdk';
import { Loader2 } from 'lucide-react';
import { CopyButton } from '@src/components/ui/copy-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { notify } from '@src/notifications';

/**
 * Where this channel's messages go — the hub webhook claim that delivers to it (``webhook/@<provider>`` →
 * claim → one place). Read from the hub every time it is shown: the hub is the only place a claim lives.
 *
 * "Delivered to" switches the claim between this computer and a cloud placement of the agent that owns the
 * channel. The URL never changes and the vendor is not touched; the next message lands at the new place.
 */
export function ChannelRouteControl({ source }: { source: DataSource }) {
  const { t } = useLingui();
  const [route, setRoute] = useState<ChannelRoute | null>(null);
  const [moving, setMoving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRoute(await source.route());
    } catch {
      setRoute(null); // no hub reachable, or no claim yet: nothing to show
    }
  }, [source]);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = route?.claim;
  if (!route || !claim) return null;

  const move = async (place: string) => {
    setMoving(true);
    try {
      await source.setRoute(place);
      await load();
    } catch (e) {
      const said = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      notify.error({ title: said || (e instanceof Error ? e.message : String(e)) });
    } finally {
      setMoving(false);
    }
  };

  const last = claim.recent?.[0];
  return (
    <div className="flex flex-col gap-1.5 rounded border px-3 py-2 text-xs" data-testid={`channel-route-${source.id}`}>
      <div className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-muted-foreground">
          <Trans>Delivered to</Trans>
        </span>
        <Select value={route.current || undefined} onValueChange={(place) => void move(place)} disabled={moving}>
          <SelectTrigger className="h-7 w-64 text-xs" data-testid="channel-route-place">
            <SelectValue placeholder={t`Somewhere else`} />
          </SelectTrigger>
          <SelectContent>
            {route.places.map((place) => (
              <SelectItem key={place.key} value={place.key} data-testid={`channel-route-place-${place.key}`}>
                {place.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {moving && <Loader2 className="size-3.5 animate-spin" />}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-24 shrink-0 text-muted-foreground">
          <Trans>Webhook</Trans>
        </span>
        <code className="min-w-0 truncate" title={claim.url} data-testid="channel-route-url">
          {claim.url}
        </code>
        <CopyButton value={claim.url} testId="channel-route-copy-url" />
      </div>
      <div className="flex items-center gap-2 text-muted-foreground" data-testid="channel-route-stats">
        <span className="w-24 shrink-0">
          <Trans>Deliveries</Trans>
        </span>
        <span>
          {claim.deliveries}
          {last ? ` · ${t`last`} ${new Date(last.at * 1000).toLocaleTimeString()} → ${last.status}` : ''}
        </span>
        {claim.misroutes > 0 && (
          <span
            className="rounded border border-red-500/60 bg-red-500/10 px-1.5 text-foreground"
            title={t`Delivered to a place that does not hold this channel`}
          >
            {claim.misroutes} <Trans>misrouted</Trans>
          </span>
        )}
      </div>
    </div>
  );
}
