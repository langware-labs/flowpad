/**
 * Every MessageChannel — a data source that sends and receives messages — and where its messages arrive: the hub
 * claim that delivers to it (this computer, another instance, a machine, nowhere yet) or the source fetching its own,
 * how its deliveries went, and who answers it. Hub claims whose channel is not on this instance are listed too.
 * `Data sources › Channels` (`/dock/data-sources/channels`).
 */
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DataSource, type MessageChannelRow } from '@sdk';
import { RefreshCw } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { humanizeSeconds } from '@src/utils/duration';
import { HEADER_ROW } from './DataSourceRow';
import { sourceGlyphs } from './source-icon';
import { openSource } from './data-sources-pointer';
import { useSourceSpecs } from './use-source-specs';

/** The one column template the header and every row share. */
const CHANNEL_GRID =
  'grid grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1fr)] items-center gap-x-4 px-4';

export function MessageChannelsList() {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { specFor } = useSourceSpecs();
  const [rows, setRows] = useState<MessageChannelRow[] | null>(null);
  const [failed, setFailed] = useState('');

  // The view owns its fetch (URL-first: the loader resolves nothing here); the hub is the only place claims live.
  const load = useCallback(async () => {
    try {
      setRows(await DataSource.channels());
      setFailed('');
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const routedLabel: Record<MessageChannelRow['routed'], string> = {
    this: t`This computer`,
    instance: t`Another Flowpad instance`,
    node: t`A machine`,
    nowhere: t`Nowhere yet`,
    unclaimed: t`Not connected — press Connect`,
    polls: t`This computer (fetches its own)`,
  };

  const answeredLabel: Record<string, string> = {
    deployment: t`A deployment`,
    agent: t`Its agent`,
    nobody: t`Nobody yet`,
  };

  return (
    <div className="flex flex-col gap-3" data-testid="message-channels">
      <div className="flex items-start gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          <Trans>
            Every channel that sends and receives messages, and where its messages arrive. A channel on Flowpad&apos;s
            own accounts arrives through the hub, which only hands each message to the place below.
          </Trans>
        </p>
        <Button size="sm" variant="ghost" className="ms-auto h-7 gap-1.5 px-2" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
          <Trans>Refresh</Trans>
        </Button>
      </div>
      {failed && <p className="rounded border border-red-500/60 bg-red-500/10 px-2 py-1.5 text-xs">{failed}</p>}
      {rows !== null && rows.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="message-channels-empty">
          <Trans>No message channels yet. Add one with New source.</Trans>
        </p>
      )}
      {rows !== null && rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className={cn(CHANNEL_GRID, HEADER_ROW)}>
            <span>
              <Trans>Channel</Trans>
            </span>
            <span>
              <Trans>Arrives at</Trans>
            </span>
            <span>
              <Trans>Deliveries</Trans>
            </span>
            <span>
              <Trans>Answered by</Trans>
            </span>
          </div>
          {rows.map((row) => {
            const spec = row.provider ? specFor(row.provider) : null;
            const { Base, Badge } = sourceGlyphs(spec, row.channel);
            const claim = row.claim;
            const last = claim?.recent?.[0];
            const answeredBy = answeredLabel[row.answered_by] ?? '—';
            return (
              <div
                key={row.source_id || claim?.id}
                className={cn(CHANNEL_GRID, 'border-b border-border py-2.5 text-sm last:border-b-0')}
                data-testid={`message-channel-${row.source_id || claim?.id}`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <IconWithBadge Base={Base} Badge={Badge} className="size-5 shrink-0" />
                  <div className="min-w-0">
                    {row.source_id ? (
                      <button
                        type="button"
                        className="block truncate font-medium hover:underline"
                        onClick={() => openSource(navigation, row.source_id)}
                      >
                        {row.name}
                      </button>
                    ) : (
                      <span className="block truncate font-medium text-muted-foreground">{row.name}</span>
                    )}
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {[row.channel, claim?.claim?.key].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                </div>
                <div className="min-w-0 text-xs">
                  <span
                    className={cn((row.routed === 'nowhere' || row.routed === 'unclaimed') && 'text-muted-foreground')}
                  >
                    {routedLabel[row.routed]}
                  </span>
                  {claim && claim.status !== 'active' && (
                    <span className="ms-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {claim.status === 'pending' ? t`waiting for the code` : t`lapsed`}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {claim ? (
                    <>
                      {claim.deliveries}
                      {last && ` · ${humanizeSeconds(Date.now() / 1000 - last.at)} ago · ${last.status}`}
                      {claim.misroutes > 0 && (
                        <span className="ms-1.5 rounded border border-red-500/60 bg-red-500/10 px-1 text-[10px] text-foreground">
                          {t`${claim.misroutes} misrouted`}
                        </span>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </div>
                <div className="text-xs">{answeredBy}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
