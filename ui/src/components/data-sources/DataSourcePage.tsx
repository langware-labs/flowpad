/**
 * One configured source — what went through ONE of this machine's pipes. `Data sources › <source>`, three tabs:
 *
 *   Messages  the conversations that came through it, live — the stream inbox's own list, narrowed by the backend to
 *             this source (`channel_source_id`). Only for a source that carries messages.
 *   Events    what it announced on the bus (`data_source:<id>`), live.
 *   Settings  how it is set up: what is unfinished, where its messages go, its driver, file and folder.
 *
 * The person's stream inbox stays theirs — everything addressed to them from every machine — and is never narrowed to a
 * machine's source. The tab rides the URL (`/dock/data-sources/<id>/<tab>`); the view owns the dialogs, as it does
 * for the rows.
 */
import { type DataSource, type DataDriver, Agent } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ExternalLink, History } from 'lucide-react';
import { timeSince, timeUntil } from '@src/utils/duration';
import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { StreamInboxView } from '@src/components/stream-inbox-view/StreamInboxView';
import { ownerOf } from '@src/components/stream-inbox-view/channel-owner';
import { BusStream } from '@src/components/automations/BusStream';
import { sourceGlyphs } from './source-icon';
import { SourceActions, SourceSetupDetails, SourceStatusLine } from './source-parts';
import { openDriver, openSource, openSourceFile, type SourceTab } from './data-sources-pointer';
import { OpenFolderButton } from './OpenFolderButton';
import { isMessageDriverSpec } from './use-source-specs';

interface Props {
  /** The source, from the view's live list (null while it loads, or once it is deleted). */
  source: DataSource | null;
  id: string;
  tab: SourceTab | null;
  spec?: DataDriver | null;
  onEdit: (source: DataSource) => void;
  onReplay: (source: DataSource) => void;
  onDelete: (source: DataSource) => void;
}

export function DataSourcePage({ source, id, tab, spec, onEdit, onReplay, onDelete }: Props) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  if (!source) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="data-source-page-missing">
        <Trans>This source is not on this machine (it may have been deleted).</Trans>{' '}
        <button type="button" className="underline" onClick={() => navigation.openDock(DockPointer.forDataSources())}>
          <Trans>Back to Data sources</Trans>
        </button>
      </p>
    );
  }
  const carriesMessages = isMessageDriverSpec(spec);
  const tabs: { key: SourceTab; label: string }[] = [
    ...(carriesMessages ? [{ key: 'messages' as const, label: t`Messages` }] : []),
    { key: 'events', label: t`Events` },
    { key: 'settings', label: t`Settings` },
  ];
  // The URL decides; an absent (or, for this source, impossible) tab falls to its first one.
  const active = tabs.some((x) => x.key === tab) ? (tab as SourceTab) : tabs[0].key;
  const { Base, Badge } = sourceGlyphs(spec, source.channel);
  const owner = ownerOf(source);
  // An agent's source answers in the agent's stream inbox: its conversations open agent-scoped.
  const agentPrefix = `${Agent.type}-`;
  const agentId = owner?.startsWith(agentPrefix) ? owner.slice(agentPrefix.length) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`data-source-page-${source.id}`}>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-border px-4 py-3">
        <IconWithBadge Base={Base} Badge={Badge} className="size-7 shrink-0" />
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{source.name || source.provider}</h2>
          <p className="font-mono text-[11px] text-muted-foreground">
            {source.provider}
            {source.channel && source.channel !== source.provider && ` · ${source.channel}`}
          </p>
        </div>
        <SourceStatusLine source={source} className="ms-2" />
        <span className="text-xs text-muted-foreground" title={t`Last successful sync`}>
          <Trans>Synced {timeSince(source.last_synced_at)}</Trans>
        </span>
        <span className="text-xs text-muted-foreground" title={t`Next scheduled poll`}>
          {source.isActive ? <Trans>Next poll {timeUntil(source.next_poll_at)}</Trans> : null}
        </span>
        <div className="ms-auto">
          <SourceActions source={source} spec={spec} onEdit={onEdit} onReplay={onReplay} onDelete={onDelete} />
        </div>
      </div>

      <div className="mb-3 flex gap-1 border-b border-border" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={active === x.key}
            data-testid={`data-source-tab-${x.key}`}
            onClick={() => openSource(navigation, id, x.key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm',
              active === x.key
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>

      {active === 'messages' && (
        <div className="min-h-[24rem] flex-1 overflow-hidden rounded-lg border border-border">
          <StreamInboxView sourceId={source.id} agentId={agentId} embedded />
        </div>
      )}

      {active === 'events' && (
        <div className="flex flex-col gap-3">
          <BusStream target={`data_source:${source.id}`} />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() =>
                navigation.openDock(DockPointer.forAutomations({ place: 'bus', target: `data_source:${source.id}` }))
              }
            >
              <ExternalLink className="size-3.5" /> <Trans>Open the event bus</Trans>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => navigation.openDock(DockPointer.forProcessRuns({ data_source_id: source.id }))}
            >
              <History className="size-3.5" /> <Trans>Runs</Trans>
            </Button>
          </div>
        </div>
      )}

      {active === 'settings' && (
        <div className="flex max-w-2xl flex-col gap-3">
          <SourceSetupDetails source={source} spec={spec} />
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">
              <Trans>Driver</Trans>
            </dt>
            <dd>
              <button
                type="button"
                className="font-mono hover:underline"
                onClick={() => openDriver(navigation, source.provider)}
              >
                {source.provider}
              </button>
            </dd>
            <dt className="text-muted-foreground">
              <Trans>Owner</Trans>
            </dt>
            <dd className="text-xs">{agentId ? <span className="font-mono">{owner}</span> : t`you`}</dd>
            {source.asset_ref && (
              <>
                <dt className="text-muted-foreground">
                  <Trans>File</Trans>
                </dt>
                <dd className="flex items-center gap-2">
                  <button
                    type="button"
                    className="font-mono text-xs hover:underline"
                    data-testid={`data-source-page-file-${source.id}`}
                    onClick={() => openSourceFile(navigation, source.asset_ref)}
                  >
                    data_source.json
                  </button>
                  <OpenFolderButton path={source.asset_ref} />
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
