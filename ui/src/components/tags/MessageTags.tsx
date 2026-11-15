import { useState, type CSSProperties } from 'react';
import { Info, Plus, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { QueryRequest, Tag, type FlowMessage } from '@sdk';
import { useQuery } from '@tanstack/react-query';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { EntityChip, iconForEntity } from '@src/components/conversation/EntityChip';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { errorMessage } from '@src/lib/error-message';
import { TagInput } from './TagInput';
import { messageTagContext } from './message-tag-navigation';

export const inboxTagsQuery = new QueryRequest({ type: Tag.type, scope: [], name: 'tags:definitions' });

export function useTagDefinitions() {
  const live = useEntitiesQuery<Tag>(inboxTagsQuery);
  const shipped = useQuery({
    queryKey: ['tags', 'shipped-definitions'],
    queryFn: () => Tag.definitions(),
    retry: false,
  });
  return [
    ...(live.data ?? []),
    ...(shipped.data ?? []).filter((tag) => tag.system && !(live.data ?? []).some((row) => row.name === tag.name)),
  ];
}

/** A tag colour remains readable in both themes; text uses the app foreground. */
export function tagChipStyle(color?: string | null): CSSProperties | undefined {
  return color
    ? {
        borderColor: color,
        backgroundColor: `color-mix(in srgb, ${color} 18%, hsl(var(--background)))`,
        color: 'hsl(var(--foreground))',
      }
    : undefined;
}

/** Projection only: assignment and queue decisions are owned by the message actions. */
export function MessageTags({ message, compact = false }: { message: FlowMessage; compact?: boolean }) {
  // An inbox row with no tags and nothing queued draws nothing, so it subscribes to nothing.
  if (compact && !message.tags?.length && !message.message_processing?.queue?.length) return null;
  return <MessageTagStrip message={message} compact={compact} />;
}

function MessageTagStrip({ message, compact }: { message: FlowMessage; compact: boolean }) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const context = messageTagContext(message);
  const panel = currentDock?.options?.message_tags;
  const setPanel = (kind: 'picker' | 'queue', open: boolean) => {
    if (!currentDock || (!open && panel !== `${message.id}:${kind}`)) return;
    navigation.openDock(currentDock.withOption('message_tags', open ? `${message.id}:${kind}` : null));
  };
  const definitions = useTagDefinitions();
  const [error, setError] = useState<string | null>(null);
  const tags = message.tags ?? [];
  const processing = message.message_processing;
  const queue = processing?.queue ?? [];
  const TriggerIcon = iconForEntity('trigger');
  const mutate = async (name: string, remove: boolean) => {
    setError(null);
    try {
      if (remove) await message.removeTag(name);
      else await message.addTag(name);
    } catch (e) {
      setError(errorMessage(e, t`Could not change tags`));
    }
  };
  const chip = (name: string, removable: boolean) => {
    const tag = definitions.find((item) => item.name === name);
    const assignment = processing?.assignments?.[name];
    return (
      <span key={name} className="inline-flex shrink-0 items-center gap-0.5" data-message-tag={name}>
        <EntityChip
          entity={{ type: Tag.type, id: tag?.id, name: name.split('.').at(-1) }}
          style={tagChipStyle(tag?.color)}
          title={`${name} · ${assignment?.source ?? 'manual'}`}
          onClick={() => navigation.openDock(DockPointer.forTagGraph(name, { carry: { ...context, origin_tag: name } }))}
        />
        {assignment?.source === 'automation' && assignment.trigger_id && (
          <button
            type="button"
            aria-label={t`Open source automation for ${name}`}
            data-testid={`tag-source-${name}`}
            onClick={() => navigation.openDock(DockPointer.forAutomations({ trigger: assignment.trigger_id, ...context }))}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            <TriggerIcon className="size-3" />
          </button>
        )}
        {removable && (
          <button
            type="button"
            aria-label={t`Remove tag ${name}`}
            data-testid={`message-tag-remove-${name}`}
            onClick={() => void mutate(name, true)}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            <X className="size-3" />
          </button>
        )}
      </span>
    );
  };
  return (
    <span
      data-testid={compact ? 'inbox-message-tags' : 'message-tags'}
      onClick={(event) => event.stopPropagation()}
      className={
        compact
          ? 'group/tags flex max-w-[7rem] shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap focus-within:max-w-[50%] hover:max-w-[50%]'
          : 'flex min-w-0 items-center gap-1 self-center'
      }
    >
      <span className="flex min-w-0 items-center gap-1 overflow-hidden">
        {(compact ? tags : tags.slice(0, 3)).map((name, index) => compact && index > 0
          ? <span key={name} className="hidden group-focus-within/tags:inline-flex group-hover/tags:inline-flex">{chip(name, false)}</span>
          : chip(name, !compact))}
      </span>
      {compact && tags.length > 1 && <span className="shrink-0 text-[10px] text-muted-foreground group-focus-within/tags:hidden group-hover/tags:hidden">+{tags.length - 1}</span>}
      {
        <Popover open={panel === `${message.id}:picker`} onOpenChange={(open) => setPanel('picker', open)}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="message-tags-menu"
              aria-label={t`Edit message tags`}
              className={
                compact
                  ? 'hidden shrink-0 rounded px-1 text-muted-foreground group-focus-within/tags:inline-flex group-hover/tags:inline-flex'
                  : 'shrink-0 rounded px-1 text-xs text-muted-foreground hover:bg-muted'
              }
            >
              {compact ? (
                <Info className="size-3" />
              ) : tags.length > 3 ? (
                `+${tags.length - 3}`
              ) : (
                <Plus className="size-3" />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" data-testid="message-tags-picker">
            <h3 className="mb-2 text-sm font-medium">
              <Trans>Message tags</Trans>
            </h3>
            <button type="button" aria-label={t`Close tags`} data-testid="message-tags-close" className="absolute end-3 top-3 text-muted-foreground" onClick={() => setPanel('picker', false)}><X className="size-3" /></button>
            <div className="mb-2 flex flex-wrap gap-1" data-testid="message-picker-tags">
              {tags.map((name) => chip(name, true))}
            </div>
            <TagInput
              tags={tags}
              hideTags
              onAdd={(name) => void mutate(name, false)}
              onRemove={(name) => void mutate(name, true)}
            />
            {processing?.classification === 'failed' && (
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                {processing.classification_error || t`Classification failed. You can still assign tags.`}
              </p>
            )}
            {processing?.classification === 'succeeded' && !tags.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                <Trans>No matching tags</Trans>
              </p>
            )}
            <button
              type="button"
              className="mt-3 text-xs underline"
              data-testid="message-tags-manage"
              onClick={() => navigation.openDock(DockPointer.forTagGraph(null, { carry: { ...context, origin_tag: tags[0] ?? '', manage: 'inbox' } }))}
            >
              <Trans>Inbox tags</Trans>
            </button>
            <button
              type="button"
              className="ms-3 mt-3 text-xs underline"
              data-testid="message-tags-create"
              onClick={() =>
                navigation.openDock(DockPointer.forTagGraph(null, { carry: { ...context, origin_tag: tags[0] ?? '', manage: 'inbox', creating: 'tag' } }))
              }
            >
              <Trans>New tag</Trans>
            </button>
            {!!tags.length && (
              <button
                type="button"
                className="ms-3 mt-3 text-xs underline"
                data-testid="message-tags-remove-all"
                onClick={() =>
                  void message.setTags([]).catch((e) => setError(errorMessage(e, t`Could not change tags`)))
                }
              >
                <Trans>Remove all</Trans>
              </button>
            )}
            {error && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </PopoverContent>
        </Popover>
      }
      {!compact && queue.length > 0 && (
        <Popover open={panel === `${message.id}:queue`} onOpenChange={(open) => setPanel('queue', open)}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="message-automation-queue"
              aria-label={t`Message automation queue`}
              className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
            >
              <TriggerIcon className="size-3" />
              {queue.length}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96" data-testid="message-automation-queue-panel">
            <h3 className="mb-2 text-sm font-medium">
              <Trans>Automation queue</Trans>
            </h3>
            <button type="button" aria-label={t`Close automations`} data-testid="message-queue-close" className="absolute end-3 top-3 text-muted-foreground" onClick={() => setPanel('queue', false)}><X className="size-3" /></button>
            <ol className="space-y-2">
                {queue.map((entry) => (
                  <li
                    key={entry.id}
                    data-testid={`queue-entry-${entry.trigger_id}`}
                    data-status={entry.status}
                    className="rounded border border-border p-2 text-xs"
                  >
                    <EntityChip
                      entity={{ type: 'trigger', id: entry.trigger_id, name: entry.automation_name }}
                      size="inline"
                  onClick={() => navigation.openDock(DockPointer.forAutomations({ trigger: entry.trigger_id, ...context }))}
                    />
                    <span className="float-end text-muted-foreground">{entry.status}</span>
                    <div className="mt-1 text-muted-foreground">{entry.tag}</div>
                    {entry.error && (
                      <p role="status" className="mt-1">
                        {entry.error}
                      </p>
                    )}
                    {entry.run_id && !['queued', 'cancelled', 'skipped'].includes(entry.status) && (
                      <button
                        type="button"
                        className="mt-1 underline"
                        data-testid={`queue-history-${entry.id}`}
                      onClick={() => navigation.openDock(DockPointer.forAutomations({ place: 'runs', run: entry.run_id }))}
                      >
                        <Trans>Run history</Trans>
                      </button>
                    )}
                  </li>
                ))}
            </ol>
          </PopoverContent>
        </Popover>
      )}
      {error && !compact && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
