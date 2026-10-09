/**
 * One configured source — what went through ONE of this machine's pipes. `Data sources › <source>`.
 *
 * Simple (`/dock/data-sources/<id>`, the default): the source's stream and nothing else — a message source's
 * conversation, messages going back and forth with the composer under them (its list when it has several); any other
 * source's live events. The header's Advanced (any tab in the URL) opens the rest, three tabs:
 *
 *   Messages  the conversations that came through it, live — the stream inbox's own list, narrowed by the backend to
 *             this source (`channel_source_id`). Only for a source that carries messages. A conversation opens in
 *             place (`<id>/messages/<conversation>[/<thread>]`), so reading a message never leaves the source.
 *   Events    what it announced on the bus (`data_source:<id>`), live.
 *   Settings  how it is set up: what is unfinished, where its messages go, its driver, file and folder.
 *
 * The person's stream inbox stays theirs — everything addressed to them from every machine — and is never narrowed to a
 * machine's source. The tab rides the URL (`/dock/data-sources/<id>/<tab>`); the view owns the dialogs, as it does
 * for the rows.
 */
import { type DataSource, type DataDriver, Agent } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';
import { ArrowLeft, ExternalLink, History, SlidersHorizontal } from 'lucide-react';
import type { Conversation } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { ConversationPanel } from '@src/components/conversation/ConversationPanel';
import { timeSince, timeUntil } from '@src/utils/duration';
import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { StreamInboxView } from '@src/components/stream-inbox-view/StreamInboxView';
import { ownerOf, sourceConversationsRequest } from '@src/components/stream-inbox-view/channel-owner';
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
  /** A conversation of this source open on its Messages tab, and the thread open in it. */
  conversation?: string | null;
  thread?: string | null;
  spec?: DataDriver | null;
  onEdit: (source: DataSource) => void;
  onReplay: (source: DataSource) => void;
  onDelete: (source: DataSource) => void;
}

export function DataSourcePage({ source, id, tab, conversation, thread, spec, onEdit, onReplay, onDelete }: Props) {
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
  // The URL decides: no tab is the simple view; a tab (or an open conversation) is Advanced, and a tab impossible for
  // this source falls to its first one.
  const advanced = !!tab || !!conversation;
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
          {advanced && (
            <p className="font-mono text-[11px] text-muted-foreground">
              {source.provider}
              {source.channel && source.channel !== source.provider && ` · ${source.channel}`}
            </p>
          )}
        </div>
        <SourceStatusLine source={source} className="ms-2" />
        {advanced && (
          <>
            <span className="text-xs text-muted-foreground" title={t`Last successful sync`}>
              <Trans>Synced {timeSince(source.last_synced_at)}</Trans>
            </span>
            <span className="text-xs text-muted-foreground" title={t`Next scheduled poll`}>
              {source.isActive ? <Trans>Next poll {timeUntil(source.next_poll_at)}</Trans> : null}
            </span>
          </>
        )}
        <div className="ms-auto flex items-center gap-1">
          <Button
            size="sm"
            variant={advanced ? 'secondary' : 'ghost'}
            className="h-7 gap-1.5 px-2 text-xs"
            aria-pressed={advanced}
            data-testid="data-source-advanced"
            title={advanced ? t`Back to the simple view` : t`Messages list, events and settings`}
            onClick={() => (advanced ? openSource(navigation, id) : openSource(navigation, id, tabs[0].key))}
          >
            <SlidersHorizontal className="size-3.5" />
            <Trans>Advanced</Trans>
          </Button>
          <SourceActions source={source} spec={spec} onEdit={onEdit} onReplay={onReplay} onDelete={onDelete} />
        </div>
      </div>

      {!advanced &&
        (carriesMessages ? (
          <div className="min-h-[24rem] flex-1 overflow-hidden rounded-lg border border-border">
            <SourceStream source={source} agentId={agentId} />
          </div>
        ) : (
          <BusStream target={`data_source:${source.id}`} />
        ))}

      {advanced && (
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
      )}

      {advanced && active === 'messages' && (
        <div className="min-h-[24rem] flex-1 overflow-hidden rounded-lg border border-border">
          {conversation ? (
            <SourceConversation
              sourceId={source.id}
              conversationId={conversation}
              thread={thread ?? null}
              agentId={agentId}
            />
          ) : (
            <StreamInboxView
              sourceId={source.id}
              agentId={agentId}
              embedded
              onOpenConversation={(conv) => openSource(navigation, source.id, 'messages', conv)}
            />
          )}
        </div>
      )}

      {advanced && active === 'events' && (
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

      {advanced && active === 'settings' && (
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

/**
 * The simple view of a message source: its messages going back and forth, nothing to click first. A source that is
 * one conversation (Flow on WhatsApp: the person IS the conversation) is that conversation, composer included;
 * several fall to their list, each opening in place.
 */
function SourceStream({ source, agentId }: { source: DataSource; agentId?: string }) {
  const { navigation } = useDockNavigation();
  const request = useMemo(() => sourceConversationsRequest(source.id), [source.id]);
  const { data: conversations = [], isSuccess } = useEntitiesQuery<Conversation>(request);
  if (!isSuccess) return null;
  if (conversations.length === 1) {
    return (
      <ConversationPanel conversationId={conversations[0].id} headerLabel={null} agentId={agentId} className="h-full" />
    );
  }
  if (conversations.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="data-source-stream-empty">
        <Trans>No messages yet — they show up here as they arrive.</Trans>
      </p>
    );
  }
  return (
    <StreamInboxView
      sourceId={source.id}
      agentId={agentId}
      embedded
      onOpenConversation={(conv) => openSource(navigation, source.id, 'messages', conv)}
    />
  );
}

/** One of the source's conversations, read on the source's page: back goes to its messages, not to the stream inbox. */
function SourceConversation({
  sourceId,
  conversationId,
  thread,
  agentId,
}: {
  sourceId: string;
  conversationId: string;
  thread: string | null;
  agentId?: string;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`data-source-conversation-${conversationId}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2"
          title={t`All messages of this source`}
          data-testid="data-source-conversation-back"
          onClick={() => openSource(navigation, sourceId, 'messages')}
        >
          <ArrowLeft className="size-3.5" />
          <Trans>All messages</Trans>
        </Button>
      </div>
      <ConversationPanel
        conversationId={conversationId}
        // The panel's own header: the editable title, project and members, as everywhere a conversation is read.
        headerLabel={t`Conversation`}
        threadId={thread}
        onThreadNavigate={(next) => openSource(navigation, sourceId, 'messages', conversationId, next)}
        agentId={agentId}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
