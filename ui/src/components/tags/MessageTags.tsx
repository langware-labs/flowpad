import { forwardRef, useMemo, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { Tag as TagIcon, X, Zap } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { FlowMessage, QueryRequest, Tag, tagIsWithin, tagTree } from '@sdk';
import { useQuery } from '@tanstack/react-query';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useAutomations } from '@src/hooks/automations/useAutomations';
import { EntityChip, iconForEntity } from '@src/components/conversation/EntityChip';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { errorMessage } from '@src/lib/error-message';
import { TagInput } from './TagInput';
import { TagOffIcon } from './TagOffIcon';
import { messageTagContext, messageTagReturn } from './message-tag-navigation';

export const streamInboxTagsQuery = new QueryRequest({ type: Tag.type, scope: [], name: 'tags:definitions' });
export const classificationSettingsKey = ['tags', 'classification-settings'];

export function useTagDefinitions() {
  const live = useEntitiesQuery<Tag>(streamInboxTagsQuery);
  const shipped = useQuery({
    queryKey: ['tags', 'shipped-definitions'],
    queryFn: () => Tag.definitions(),
    retry: false,
  });
  return useMemo(() => {
    const rows = live.data ?? [];
    const named = new Set(rows.map((row) => row.name));
    return [...rows, ...(shipped.data ?? []).filter((tag) => tag.system && !named.has(tag.name))];
  }, [live.data, shipped.data]);
}

/** Each tag's colour by name, for the chips and icons that draw it. */
export function useTagColors(): Map<string, string | null | undefined> {
  const definitions = useTagDefinitions();
  return useMemo(() => new Map(definitions.map((tag) => [tag.name ?? '', tag.color])), [definitions]);
}

/** The classification settings (enabled, root …), one cached read shared by the menu and the editor. */
export function useClassificationSettings() {
  const query = useQuery({
    queryKey: classificationSettingsKey,
    queryFn: () => FlowMessage.classificationSettings(),
    retry: false,
  });
  // The tree a message is classified into; the server's default until the settings arrive.
  return { settings: query.data, root: query.data?.root ?? 'stream_inbox' };
}

/** The message rules a tag starts: its own, and the ones a parent tag hands down (a rule on a tag also
 *  runs for every tag under it). Read from the automations list, shared with that screen's cache. */
export function useTagAutomations() {
  const { data = [] } = useAutomations({ poll: false });
  return useMemo(() => {
    const rules = data.filter((rule) => rule.when.event?.message_tags?.length);
    return (tag: string) =>
      rules.flatMap((rule) => {
        const from = rule.when.event!.message_tags!.find((ruleTag) => tagIsWithin(tag, ruleTag));
        return from ? [{ rule, from, inherited: from !== tag }] : [];
      });
  }, [data]);
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

/** The tags under `root` as a tree: each node with its depth, intermediates included. */
export function treeRows(names: string[], root: string): Array<{ name: string; depth: number }> {
  const tree = tagTree(names.filter((name) => tagIsWithin(name, root)));
  const rows: Array<{ name: string; depth: number }> = [];
  const walk = (parent: string, depth: number) => {
    for (const child of tree[parent] ?? []) {
      rows.push({ name: child, depth });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

type TagTreeRow = { name: string; depth: number };

/** The live (not deprecated) tags of the classification tree, as rows. */
export function useTagTreeRows(): TagTreeRow[] {
  const definitions = useTagDefinitions();
  const { root } = useClassificationSettings();
  return useMemo(
    () => treeRows(definitions.filter((tag) => !tag.deprecated).map((tag) => tag.name ?? ''), root),
    [definitions, root],
  );
}

/** The tag tree as a list of ticks — a message's tags, or the Stream Inbox's tag filter. */
export function TagTreeList({
  rows,
  isOn,
  onToggle,
  optionTestId,
  trailing,
  'data-testid': testId,
}: {
  rows: TagTreeRow[];
  isOn: (name: string) => boolean;
  /** `on` is the tick's state before the click. */
  onToggle: (name: string, on: boolean) => void;
  optionTestId: string;
  trailing?: (name: string) => ReactNode;
  'data-testid'?: string;
}) {
  const colors = useTagColors();
  return (
    <ul className="max-h-64 overflow-auto" data-testid={testId}>
      {rows.map(({ name, depth }) => {
        const on = isOn(name);
        return (
          <li key={name} style={{ paddingInlineStart: 4 + depth * 16 }}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted">
              <input type="checkbox" checked={on} data-testid={`${optionTestId}-${name}`} onChange={() => onToggle(name, on)} />
              <TagIcon className="size-3" style={{ color: colors.get(name) ?? undefined }} />
              {name.split('.').at(-1)}
              {trailing?.(name)}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** The message's quick-menu panel lives in the URL (`message_tags=<id>:picker|queue`). */
function useMessagePanel(message: FlowMessage) {
  const { navigation, currentDock } = useDockNavigation();
  const panel = currentDock?.options?.message_tags;
  const isOpen = (kind: 'picker' | 'queue') => panel === `${message.id}:${kind}`;
  const setOpen = (kind: 'picker' | 'queue', open: boolean) => {
    if (!currentDock || (!open && !isOpen(kind))) return;
    navigation.openDock(currentDock.withOption('message_tags', open ? `${message.id}:${kind}` : null));
  };
  return { navigation, isOpen, setOpen };
}

/** The queue statuses a person can act on with Run again. */
const FAILED = ['failed', 'interrupted'];

/** Projection only: assignment and queue decisions are owned by the message actions. */
export function MessageTags({ message, compact = false }: { message: FlowMessage; compact?: boolean }) {
  return compact ? <TagCell message={message} /> : <MessageTagStrip message={message} />;
}

/** A Stream Inbox row's one tag cell: none → the crossed tag, one → its chip, more → the first + count.
 *  Every form opens the same quick menu. A row with no tags reads no definitions until it is opened. */
function TagCell({ message }: { message: FlowMessage }) {
  // Read without a hook: the failed chip mounts on the few rows that have one, not on every row.
  const failed = (message.message_processing?.queue ?? []).find((entry) => FAILED.includes(entry.status));
  // One QuickMenu whatever the count: ticking the first tag must not remount the open menu.
  return (
    <span
      data-testid="stream-inbox-message-tags"
      className="flex shrink-0 items-center"
      onClick={(e) => e.stopPropagation()}
    >
      {failed && <FailedAutomation message={message} name={failed.automation_name} />}
      <QuickMenu message={message}>
        <CellTrigger tags={message.tags ?? []} />
      </QuickMenu>
    </span>
  );
}

/** A row whose message has an automation that failed says so; the chip opens that message's queue. */
function FailedAutomation({ message, name }: { message: FlowMessage; name: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const back = messageTagReturn(messageTagContext(message), 'queue');
  if (!back) return null;
  return (
    <button
      type="button"
      data-testid="stream-inbox-row-failed"
      title={t`${name} failed`}
      onClick={() => navigation.openDock(back)}
      className="me-1 inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-destructive/60 px-2 text-[11px] text-destructive hover:bg-destructive/10"
    >
      <Zap className="size-3" />
      <Trans>failed</Trans>
    </button>
  );
}

/** No tags: the crossed tag. Else the first tag in its colour, plus how many more. The popover's trigger. */
const CellTrigger = forwardRef<HTMLButtonElement, { tags: string[] } & ButtonHTMLAttributes<HTMLButtonElement>>(
  function CellTrigger({ tags, ...props }, ref) {
    const { t } = useLingui();
    const colors = useTagColors();
    const first = tags[0];
    if (!first) {
      return (
        <button
          ref={ref}
          type="button"
          {...props}
          data-testid="message-tags-menu"
          aria-label={t`No tags — add one`}
          title={t`No tags`}
          className="inline-flex h-6 items-center rounded-full border border-dashed border-foreground/60 px-2 text-foreground hover:bg-muted"
        >
          <TagOffIcon className="size-3" />
        </button>
      );
    }
    return (
      <button
        ref={ref}
        type="button"
        {...props}
        data-testid="message-tags-menu"
        data-message-tag={first}
        title={tags.join(', ')}
        style={tagChipStyle(colors.get(first))}
        className="inline-flex h-6 max-w-[7rem] items-center gap-1 rounded-full border border-border bg-muted/30 px-2.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <TagIcon className="size-3 shrink-0" />
        <span className="truncate">{first.split('.').at(-1)}</span>
        {tags.length > 1 && <span className="shrink-0 opacity-70">+{tags.length - 1}</span>}
      </button>
    );
  },
);

/** One tag assigned to a message: opens its tag, names the automation that set it, removes it. */
function AssignedTag({ message, name, onRemove }: { message: FlowMessage; name: string; onRemove: () => void }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const definitions = useTagDefinitions();
  const tag = definitions.find((item) => item.name === name);
  const context = messageTagContext(message);
  const assignment = message.message_processing?.assignments?.[name];
  const TriggerIcon = iconForEntity('trigger');
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" data-message-tag={name}>
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
          onClick={() =>
            navigation.openDock(DockPointer.forAutomations({ trigger: assignment.trigger_id, ...context }))
          }
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          <TriggerIcon className="size-3" />
        </button>
      )}
      <button
        type="button"
        aria-label={t`Remove tag ${name}`}
        data-testid={`message-tag-remove-${name}`}
        onClick={onRemove}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** Add or remove one tag, with the failure said once. */
function useTagChange(message: FlowMessage) {
  const { t } = useLingui();
  const [error, setError] = useState<string | null>(null);
  const change = async (name: string, remove: boolean) => {
    setError(null);
    try {
      if (remove) await message.removeTag(name);
      else await message.addTag(name);
    } catch (e) {
      setError(errorMessage(e, t`Could not change tags`));
    }
  };
  return { error, change };
}

/** The quick menu around `children` (its trigger). Content mounts only while open. */
function QuickMenu({ message, children }: { message: FlowMessage; children: ReactNode }) {
  const { isOpen, setOpen } = useMessagePanel(message);
  return (
    <Popover open={isOpen('picker')} onOpenChange={(open) => setOpen('picker', open)}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        // The tree is the menu: opening must not focus the add field, whose suggestions would cover it.
        onOpenAutoFocus={(e) => e.preventDefault()}
        align="end"
        className="w-72 p-3"
        data-testid="message-tags-picker"
      >
        <TagPicker message={message} onDone={() => setOpen('picker', false)} />
      </PopoverContent>
    </Popover>
  );
}

function TagPicker({ message, onDone }: { message: FlowMessage; onDone: () => void }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { root } = useClassificationSettings();
  const rulesOf = useTagAutomations();
  const { error, change } = useTagChange(message);
  const tags = message.tags ?? [];
  const processing = message.message_processing;
  const [asking, setAsking] = useState(false);
  const classifyNow = async () => {
    setAsking(true);
    await message.classifyNow().catch(() => undefined);
    setAsking(false);
  };
  // A tick shows at once; the message row catches up when the action answers.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const mutate = async (name: string, remove: boolean) => {
    setPending((all) => ({ ...all, [name]: !remove }));
    await change(name, remove);
    setPending((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== name)));
  };
  const rows = useTagTreeRows();
  /** The tag tree editor, opened on this message so its Try pane is about it. */
  const manageTags = (extra: Record<string, string> = {}) =>
    DockPointer.forTagGraph(null, {
      carry: { ...messageTagContext(message), origin_tag: tags[0] ?? '', manage: 'stream_inbox', ...extra },
    });
  // The add field suggests this tree's tags, not every tag in use anywhere.
  const names = useMemo(() => rows.map((row) => row.name), [rows]);
  return (
    <>
      <div className="mb-2 flex items-start gap-2">
        <div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="message-picker-tags">
          {tags.length ? (
            tags.map((name) => (
              <AssignedTag key={name} message={message} name={name} onRemove={() => void mutate(name, true)} />
            ))
          ) : (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <TagOffIcon className="size-3 text-foreground" />
              <Trans>No tags yet — tick one below</Trans>
            </span>
          )}
        </div>
        {/* Opens the tag tree's Try pane on this message and runs it at once (`run=1`). */}
        <Button
          size="sm"
          className="h-6 shrink-0 px-2"
          data-testid="message-tags-classify"
          onClick={() => navigation.openDock(manageTags({ run: '1' }))}
        >
          <Trans>Classify</Trans>
        </Button>
      </div>
      <TagInput
        tags={tags}
        hideTags
        suggestions={names}
        onAdd={(name) => void mutate(name, false)}
        onRemove={(name) => void mutate(name, true)}
      />
      <div className="mt-2 flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
        <TagIcon className="size-3" />
        {root}
      </div>
      <TagTreeList
        rows={rows}
        data-testid="message-tags-tree"
        optionTestId="message-tag-option"
        isOn={(name) => pending[name] ?? tags.includes(name)}
        onToggle={(name, on) => void mutate(name, on)}
        trailing={(name) =>
          rulesOf(name).some(({ rule }) => rule.enabled) && (
            <span
              className="ms-auto text-muted-foreground"
              title={t`Starts an automation`}
              data-testid={`message-tag-automation-${name}`}
            >
              <Zap className="size-3" />
            </span>
          )
        }
      />
      {!tags.length && !message.outbound && ['skipped', 'failed'].includes(processing?.classification ?? 'skipped') && (
        <p role="status" className="mt-2 text-xs text-muted-foreground" data-testid="message-unclassified">
          {processing?.classification === 'failed'
            ? processing.classification_error || t`Classification failed. You can still assign tags.`
            : processing
              ? t`The classifier was off when this arrived.`
              : t`This message was not classified.`}{' '}
          <button
            type="button"
            className="underline"
            disabled={asking}
            data-testid="message-classify-now"
            onClick={() => void classifyNow()}
          >
            <Trans>Classify now</Trans>
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
        <span className="flex-1" />
        <button
          type="button"
          className="text-xs underline"
          data-testid="message-tags-manage"
          onClick={() => navigation.openDock(manageTags())}
        >
          <Trans>Edit tags…</Trans>
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-xs hover:bg-muted"
          data-testid="message-tags-close"
          onClick={onDone}
        >
          <Trans>Done</Trans>
        </button>
      </div>
    </>
  );
}

/** A message bubble's tags: up to three chips (each opens its tag), the quick menu, the automation queue. */
function MessageTagStrip({ message }: { message: FlowMessage }) {
  const { t } = useLingui();
  const { navigation, isOpen, setOpen } = useMessagePanel(message);
  const { error, change } = useTagChange(message);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const context = messageTagContext(message);
  const tags = message.tags ?? [];
  const queue = message.message_processing?.queue ?? [];
  const TriggerIcon = iconForEntity('trigger');
  return (
    <span data-testid="message-tags" className="flex min-w-0 items-center gap-1 self-center">
      <span className="flex min-w-0 items-center gap-1 overflow-hidden">
        {tags.slice(0, 3).map((name) => (
          <AssignedTag key={name} message={message} name={name} onRemove={() => void change(name, true)} />
        ))}
      </span>
      <QuickMenu message={message}>
        <button
          type="button"
          data-testid="message-tags-menu"
          aria-label={t`Edit message tags`}
          className="shrink-0 rounded px-1 text-xs text-muted-foreground hover:bg-muted"
        >
          {tags.length > 3 ? (
            `+${tags.length - 3}`
          ) : tags.length ? (
            <TagIcon className="size-3" />
          ) : (
            <TagOffIcon className="size-3" />
          )}
        </button>
      </QuickMenu>
      {queue.length > 0 && (
        <Popover open={isOpen('queue')} onOpenChange={(open) => setOpen('queue', open)}>
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
            <button
              type="button"
              aria-label={t`Close automations`}
              data-testid="message-queue-close"
              className="absolute end-3 top-3 text-muted-foreground"
              onClick={() => setOpen('queue', false)}
            >
              <X className="size-3" />
            </button>
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
                    onClick={() =>
                      navigation.openDock(DockPointer.forAutomations({ trigger: entry.trigger_id, ...context }))
                    }
                  />
                  <span className="float-end text-muted-foreground">{entry.status}</span>
                  {entry.tag && <div className="mt-1 text-muted-foreground">{entry.tag}</div>}
                  {entry.error && (
                    <p role="status" className="mt-1">
                      {entry.error}
                    </p>
                  )}
                  {entry.tag && FAILED.includes(entry.status) && (
                    <button
                      type="button"
                      className="me-3 mt-1 underline"
                      data-testid={`queue-rerun-${entry.id}`}
                      onClick={() =>
                        void message
                          .rerunAutomation(entry.id)
                          .then(() => setRerunError(null))
                          .catch((e) => setRerunError(errorMessage(e, t`Could not run it again`)))
                      }
                    >
                      <Trans>Run again</Trans>
                    </button>
                  )}
                  {entry.run_id && !['queued', 'cancelled', 'skipped'].includes(entry.status) && (
                    <button
                      type="button"
                      className="mt-1 underline"
                      data-testid={`queue-history-${entry.id}`}
                      onClick={() =>
                        navigation.openDock(DockPointer.forAutomations({ place: 'runs', run: entry.run_id }))
                      }
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
      {(error || rerunError) && (
        <span role="alert" className="text-xs text-destructive">
          {error || rerunError}
        </span>
      )}
    </span>
  );
}
