import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, Plus, Tag as TagIcon, Tags, Zap } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataManager, FlowMessage, QueryFilter, QueryRequest, Tag, TypeId } from '@sdk';
import type { MessageClassification, MessageClassificationSettings } from '@sdk/entities/flow-message';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Switch } from '@src/components/ui/switch';
import { IfThenLine } from '@src/components/automations/IfThenLine';
import { useAutomationWords } from '@src/components/automations/automation-words';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import { ConversationPanel } from '@src/components/conversation/ConversationPanel';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import {
  classificationSettingsKey,
  streamInboxTagsQuery,
  treeRows,
  useClassificationSettings,
  useTagAutomations,
} from './MessageTags';
import { TagOffIcon } from './TagOffIcon';
import { KindValue } from '@src/components/value-viewer/KindValue';
import { ClassifyDialog, useClassifyRun } from './ClassifyTable';
import { messageLabel, TagChip } from './tag-chip';

const SWATCHES = ['#3b82f6', '#8b5cf6', '#f97316', '#ef4444', '#22c55e', '#14b8a6', '#eab308', '#a1a1aa'];
const recentMessagesQuery = new QueryRequest({
  type: FlowMessage.type,
  name: 'tags:try-messages',
  query: new QueryFilter({ limit: 30, order_by: { created_date: 'desc' } }),
});

/** The classification tree under the stream_inbox root: build it, say what each tag means, and try it on a message. */
export function StreamInboxTags() {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const options = currentDock?.options ?? {};
  const open = (patch: Record<string, string | null>) => {
    if (!currentDock) return;
    navigation.openDock(Object.entries(patch).reduce((dock, [key, value]) => dock.withOption(key, value), currentDock));
  };
  const queryClient = useQueryClient();
  const { data: tags = [], refetch } = useEntitiesQuery<Tag>(streamInboxTagsQuery);
  const { settings, root } = useClassificationSettings();
  const rulesOf = useTagAutomations();
  const words = useAutomationWords();
  const live = useMemo(() => tags.filter((tag) => !tag.deprecated && !tag.system), [tags]);
  const byName = useMemo(() => new Map(live.map((tag) => [tag.name ?? '', tag])), [live]);
  const rows = useMemo(() => treeRows([...byName.keys()], root), [byName, root]);
  const selected = options.node || null;
  const row = (selected && byName.get(selected)) || null;
  const rules = selected ? rulesOf(selected) : [];
  const [error, setError] = useState<string | null>(null);

  // ── details: the selected node's draft ──
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const resetDraft = () => {
    setName(selected ?? '');
    setDescription(row?.description ?? '');
    setColor(row?.color ?? SWATCHES[0]);
    setError(null);
  };
  // A node's draft loads when the node changes, not when its row refreshes under the person's typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(resetDraft, [selected, row?.id]);
  const dirty =
    !!selected &&
    (name !== selected || description !== (row?.description ?? '') || color !== (row?.color ?? SWATCHES[0]));

  const save = useMutation({
    mutationFn: async () => {
      const values = { name: name.trim(), title: name.trim().split('.').at(-1), description, color };
      if (!row) await new Tag({ ...values, stream_inbox: true }).save();
      else if (row.name === values.name) await dataManager.save(row.typeId, [], { ...row.toJSON(), ...values });
      else await row.renameMessageTag({ name: values.name, title: values.title, description, color });
      await refetch();
      return values.name;
    },
    onSuccess: (saved) => open({ node: saved }),
    onError: (e) => setError(errorMessage(e, t`Could not save tag`)),
  });

  // ── tree: add a child ──
  const adding = options.adding ?? null;
  const [child, setChild] = useState('');
  const childName =
    adding && child.trim()
      ? `${adding}.${child
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')}`
      : '';
  const addChild = useMutation({
    mutationFn: async () => {
      await new Tag({ name: childName, title: childName.split('.').at(-1), stream_inbox: true }).save();
      await refetch();
      return childName;
    },
    onSuccess: (created) => {
      setChild('');
      open({ adding: null, node: created });
    },
    onError: (e) => setError(errorMessage(e, t`Could not add tag`)),
  });

  // ── try: the message, the run, the result ──
  const messageId = options.message || null;
  const message = useEntity<FlowMessage>(messageId ? new TypeId(FlowMessage.type, messageId) : null).data;
  const [runs, setRuns] = useState<Array<{ message: string; answer: MessageClassification }>>([]);
  const run = useMutation({
    // Run asks about the tree as written: an edited meaning is saved first, so the answer is about it.
    mutationFn: async () => {
      if (dirty && row) await save.mutateAsync();
      return await message!.classify();
    },
    onSuccess: (answer) =>
      setRuns((all) => [...all.filter((r) => r.message === messageId).slice(-1), { message: messageId!, answer }]),
  });
  // `run=1` is a one-shot from a Classify button: it starts the run and leaves the URL, so a reload asks nothing.
  // It leaves by REPLACING its history entry: a pushed one keeps `run=1` behind it, and Back would run it again.
  useEffect(() => {
    if (options.run !== '1' || !message || !currentDock) return;
    run.mutate();
    navigation.openDock(currentDock.withOption('run', null), undefined, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per `run=1`, not per render
  }, [options.run, message?.id]);
  const mine = runs.filter((r) => r.message === messageId);
  const result = mine.at(-1)?.answer;
  const landed = result?.exit_code === 0 ? result.value?.tag : undefined;
  const previous = mine.length > 1 ? mine[0].answer.value?.tag : undefined;
  const stale = !!result && dirty;
  const picking = options.pick === '1' || !messageId;
  const { data: recent = [] } = useEntitiesQuery<FlowMessage>(recentMessagesQuery, { enabled: picking });
  const [search, setSearch] = useState('');
  // Ticked in the picker: Classify opens the dry-run table for them.
  const [ticked, setTicked] = useState<string[]>([]);
  const classifying = useClassifyRun();

  const updateSettings = async (patch: Partial<MessageClassificationSettings>) => {
    try {
      queryClient.setQueryData(classificationSettingsKey, await FlowMessage.classificationSettings(patch));
    } catch (e) {
      setError(errorMessage(e, t`Could not save classification settings`));
    }
  };

  const node = (nodeName: string, depth: number) => {
    const tag = byName.get(nodeName);
    return (
      <div key={nodeName}>
        <div
          role="button"
          tabIndex={0}
          data-testid={`stream-inbox-tag-row-${nodeName}`}
          onClick={() => open({ node: nodeName })}
          onKeyDown={(e) => e.key === 'Enter' && open({ node: nodeName })}
          style={{
            marginInlineStart: depth * 16,
            ...(landed === nodeName ? { boxShadow: '0 0 0 2px hsl(var(--primary))' } : {}),
          }}
          className={cn(
            'group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-sm',
            selected === nodeName ? 'bg-accent' : 'hover:bg-muted',
          )}
        >
          <TagIcon className="size-3.5 shrink-0" style={{ color: tag?.color ?? undefined }} />
          <span className={cn('truncate', !tag && 'italic text-muted-foreground')}>{nodeName.split('.').at(-1)}</span>
          {landed === nodeName && (
            <span className="text-[10px] text-primary" data-testid="stream-inbox-tag-lands">
              <Trans>lands here</Trans>
            </span>
          )}
          <button
            type="button"
            aria-label={t`Add a tag under ${nodeName}`}
            data-testid={`stream-inbox-tag-add-${nodeName}`}
            onClick={(e) => {
              e.stopPropagation();
              open({ adding: nodeName });
            }}
            className="ms-auto rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            <Plus className="size-3" />
          </button>
        </div>
        {adding === nodeName && (
          <form
            className="flex flex-wrap items-center gap-1.5 py-1"
            style={{ marginInlineStart: depth * 16 + 24 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (childName) addChild.mutate();
            }}
          >
            <input
              autoFocus
              value={child}
              onChange={(e) => setChild(e.target.value)}
              data-testid="stream-inbox-tag-child-name"
              placeholder={t`Name`}
              className="w-28 rounded border border-input bg-background px-2 py-1 text-xs"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!childName || addChild.isPending}
              data-testid="stream-inbox-tag-child-save"
            >
              <Trans>Add</Trans>
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => open({ adding: null })}>
              <Trans>Cancel</Trans>
            </Button>
            {childName && <span className="w-full text-xs text-muted-foreground">{childName}</span>}
          </form>
        )}
      </div>
    );
  };

  const [sender, subject] = messageLabel(message);
  const current = message?.tags ?? [];
  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="stream-inbox-tags-page">
      <header className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        <h1 className="flex-1 text-lg font-semibold">
          <Trans>Stream Inbox tags</Trans>
        </h1>
        {settings && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <Switch
                checked={settings.enabled}
                onCheckedChange={(enabled) => void updateSettings({ enabled })}
                aria-label={t`Classify arriving messages`}
                data-testid="message-classification-enabled"
              />
              <button
                type="button"
                disabled={!settings.trigger_id}
                data-testid="message-classifier-automation"
                onClick={() => navigation.openDock(DockPointer.forAutomations({ trigger: settings.trigger_id }))}
              >
                <IfThenLine when={words.classifier.when} then={words.classifier.under(root)} />
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={settings.include_flow_tags}
                onCheckedChange={(include_flow_tags) => void updateSettings({ include_flow_tags })}
                data-testid="message-classification-flow-tags"
              />
              <Trans>Include Flowpad message tags</Trans>
            </label>
          </>
        )}
        <Button variant="outline" size="sm" onClick={() => navigation.openDock(DockPointer.forTagGraph())}>
          <Trans>Tag graph</Trans>
        </Button>
      </header>
      {error && (
        <p role="alert" className="px-4 pt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr_20rem] gap-4 overflow-auto p-4">
        <div className="rounded-md border border-border p-2" data-testid="stream-inbox-tags-tree">
          {node(root, 0)}
          {rows.map((item) => node(item.name, item.depth + 1))}
        </div>

        <div className="rounded-md border border-border p-3">
          {selected ? (
            <form
              data-testid="stream-inbox-tag-editor"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="stream-inbox-tag-name"
                  aria-label={t`Full name`}
                  className="w-full bg-transparent text-xs text-muted-foreground outline-none"
                />
                <div className="mt-1 font-semibold">
                  {name.split('.').at(-1)}
                  {dirty && (
                    <span className="ms-1 text-primary" data-testid="stream-inbox-tag-unsaved">
                      ●
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-12 text-xs text-muted-foreground">
                  <Trans>Color</Trans>
                </span>
                {SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={swatch}
                    data-testid={`stream-inbox-tag-swatch-${swatch}`}
                    onClick={() => setColor(swatch)}
                    className="size-4 rounded-full"
                    style={{
                      background: swatch,
                      boxShadow: swatch === color ? `0 0 0 2px hsl(var(--background)), 0 0 0 4px ${swatch}` : undefined,
                    }}
                  />
                ))}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  data-testid="stream-inbox-tag-color"
                  title={t`Custom colour`}
                  className="h-6 w-8 rounded bg-background"
                />
              </div>
              <label className="block text-xs text-muted-foreground">
                <Trans>When does a message belong here?</Trans>
                <textarea
                  rows={5}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  data-testid="stream-inbox-tag-description"
                  className="mt-1 block w-full rounded border border-input bg-background p-2 text-sm text-foreground"
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={!dirty && !!row} data-testid="stream-inbox-tag-save">
                  <Trans>Save</Trans>
                </Button>
                {dirty && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid="stream-inbox-tag-cancel"
                    onClick={resetDraft}
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                )}
                {row && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid={`stream-inbox-tag-delete-${row.name}`}
                    onClick={() => setDeleting(row)}
                  >
                    <Trans>Delete</Trans>
                  </Button>
                )}
              </div>
              {row && (
                <div className="border-t border-border pt-3" data-testid="stream-inbox-tag-then">
                  <div className="mb-1.5 text-xs text-muted-foreground">
                    <Trans>Then — when a message lands here</Trans>
                  </div>
                  {rules.length === 0 && (
                    <p className="mb-2 text-sm text-muted-foreground">
                      <Trans>Nothing yet.</Trans>
                    </p>
                  )}
                  <ul className="mb-2 space-y-1">
                    {rules.map(({ rule, from, inherited }) => (
                      <li key={rule.id}>
                        <button
                          type="button"
                          data-testid={`stream-inbox-tag-rule-${rule.id}`}
                          onClick={() => navigation.openDock(DockPointer.forAutomations({ trigger: rule.id }))}
                          className={cn(
                            'flex w-full items-center gap-2 rounded px-2 py-1 text-start text-sm hover:bg-muted',
                            !rule.enabled && 'opacity-60',
                          )}
                        >
                          <Zap className="size-3.5 shrink-0" />
                          <span className="truncate">{rule.name}</span>
                          {inherited && (
                            <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                              <Trans>from {from.split('.').at(-1)}</Trans>
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="stream-inbox-tag-add-automation"
                    onClick={() =>
                      navigation.openDock(DockPointer.forAutomations({ creating: 'message', tag: selected }))
                    }
                  >
                    <Zap className="size-3.5" />
                    <Trans>Add automation</Trans>
                  </Button>
                </div>
              )}
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              <Trans>Pick a tag to say when a message belongs there.</Trans>
            </p>
          )}
        </div>

        <div className="rounded-md border border-border p-3" data-testid="stream-inbox-tag-try">
          <h2 className="mb-2 font-medium">{picking ? <Trans>Pick a message</Trans> : <Trans>Try</Trans>}</h2>
          {picking ? (
            <>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t`Search messages`}
                className="mb-2 block w-full rounded border border-input bg-background p-2 text-xs"
              />
              <ul className="max-h-80 overflow-auto">
                {recent
                  .filter(
                    (m) =>
                      m.id && !m.is_draft && messageLabel(m).join(' ').toLowerCase().includes(search.toLowerCase()),
                  )
                  .slice(0, 20)
                  .map((m) => {
                    const [who, what] = messageLabel(m);
                    return (
                      <li key={m.id} className="flex items-center gap-2 px-1">
                        <Checkbox
                          checked={ticked.includes(m.id!)}
                          onCheckedChange={() =>
                            setTicked((all) => (all.includes(m.id!) ? all.filter((id) => id !== m.id) : [...all, m.id!]))
                          }
                          aria-label={t`Select conversation`}
                          data-testid={`stream-inbox-tag-try-tick-${m.id}`}
                          className="h-3.5 w-3.5 border-muted-foreground"
                        />
                        <button
                          type="button"
                          data-testid={`stream-inbox-tag-try-pick-${m.id}`}
                          onClick={() => open({ message: m.id, conversation: m.conversation_id ?? null, pick: null })}
                          className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-start text-xs hover:bg-muted"
                        >
                          <b>{who}</b> — {what}
                        </button>
                      </li>
                    );
                  })}
              </ul>
              {ticked.length > 0 && (
                <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                  <span className="text-xs text-muted-foreground">
                    <Trans>{ticked.length} selected</Trans>
                  </span>
                  <Button
                    size="sm"
                    // One message runs right here in the Try pane; several get the dry-run table.
                    onClick={() => {
                      if (ticked.length > 1) {
                        const conversations = ticked.map((id) => recent.find((m) => m.id === id)?.conversation_id);
                        setTicked([]);
                        return classifying.start(conversations.filter((id): id is string => !!id));
                      }
                      const conversation = recent.find((m) => m.id === ticked[0])?.conversation_id ?? null;
                      setTicked([]);
                      open({ message: ticked[0], conversation, pick: null, run: '1' });
                    }}
                    data-testid="stream-inbox-tag-try-classify"
                  >
                    <Tags className="size-3.5" />
                    <Trans>Classify</Trans>
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <div
                className="relative rounded border border-border p-2 text-xs"
                data-testid="stream-inbox-tag-try-message"
              >
                <button
                  type="button"
                  data-testid="stream-inbox-tag-try-another"
                  onClick={() => open({ pick: '1' })}
                  className="absolute -top-2 end-2 inline-flex items-center gap-0.5 bg-background px-1 text-[10px] leading-[14px] text-primary"
                >
                  <Trans>Select message</Trans>
                  <ChevronDown className="size-2.5" />
                </button>
                {/* The message in full, as the Stream Inbox opens it — in a wide popup, so the editor stays put. */}
                <button
                  type="button"
                  className="block w-full text-start hover:opacity-80"
                  disabled={!message?.conversation_id}
                  onClick={() => open({ reading: '1' })}
                  data-testid="stream-inbox-tag-try-open-message"
                >
                  <b>{sender}</b>
                  <div className="truncate">{subject}</div>
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={!message || run.isPending}
                  onClick={() => run.mutate()}
                  data-testid="stream-inbox-tag-try-run"
                >
                  {run.isPending ? <Loader2 className="size-3 animate-spin" /> : '▶'}{' '}
                  {result ? <Trans>Rerun</Trans> : <Trans>Run</Trans>}
                </Button>
                {run.isPending && (
                  <span
                    role="status"
                    className="text-xs text-muted-foreground"
                    data-testid="stream-inbox-tag-try-running"
                  >
                    <Trans>Classifying…</Trans>
                  </span>
                )}
              </div>
              {run.isError && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {errorMessage(run.error, t`Could not classify`)}
                </p>
              )}
              {result && (
                <div
                  className={cn('mt-3 rounded border border-border p-2', stale && 'opacity-50')}
                  data-testid="stream-inbox-tag-try-result"
                >
                  {landed ? (
                    <>
                      <div className="text-xs text-muted-foreground">
                        {stale ? <Trans>Lands on (stale — instructions changed)</Trans> : <Trans>Lands on</Trans>}
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <TagChip name={landed} color={byName.get(landed)?.color} />
                        <span className="text-sm font-semibold" data-testid="stream-inbox-tag-try-landed">
                          {landed}
                        </span>
                      </div>
                      {previous && previous !== landed && (
                        <div
                          className="text-xs text-muted-foreground line-through"
                          data-testid="stream-inbox-tag-try-was"
                        >
                          <Trans>was {previous}</Trans>
                        </div>
                      )}
                    </>
                  ) : (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="stream-inbox-tag-try-unavailable"
                      data-reason={result.unavailable ?? ''}
                    >
                      {result.detail}
                    </p>
                  )}
                  <div
                    className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
                    data-testid="stream-inbox-tag-try-current"
                  >
                    <Trans>Current</Trans>
                    {current.length ? (
                      current.map((tag) => <TagChip key={tag} name={tag} color={byName.get(tag)?.color} />)
                    ) : (
                      <TagOffIcon className="size-3 text-foreground" aria-label={t`No tags`} />
                    )}
                  </div>
                  {landed && !current.includes(landed) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      data-testid="stream-inbox-tag-try-apply"
                      onClick={() =>
                        void message!.addTag(landed).catch((e) => setError(errorMessage(e, t`Could not change tags`)))
                      }
                    >
                      <Trans>Apply to message</Trans>
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {!picking && result?.run && (
          // The whole decision as it happened — the message it read, the tags it chose from, the answer.
          <div
            className={cn('col-span-3 rounded-md border border-border p-3', stale && 'opacity-50')}
            data-testid="stream-inbox-tag-try-data"
          >
            <KindValue kind="decision.run" value={result.run} testId="stream-inbox-tag-try-run-data" />
          </div>
        )}
      </div>
      {options.reading === '1' && message?.conversation_id && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && open({ reading: null })}>
          <DialogContent className="flex h-[85vh] max-w-6xl flex-col p-0" data-testid="stream-inbox-tag-try-reading">
            <DialogTitle className="sr-only">{subject}</DialogTitle>
            <ConversationPanel
              conversationId={message.conversation_id}
              selectedMessageId={message.id}
              className="min-h-0 flex-1"
            />
          </DialogContent>
        </Dialog>
      )}
      {classifying.callId && <ClassifyDialog callId={classifying.callId} onClose={classifying.close} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleting(null);
        }}
        testId="stream-inbox-tag-delete-confirm"
        variant="destructive"
        confirmLabel={t`Delete`}
        title={t`Delete tag`}
        description={t`Remove this tag's assignments and disable matching automations. Messages are kept.`}
        onConfirm={() => {
          void (async () => {
            if (!deleting) return;
            try {
              await deleting.deleteMessageTag();
              setDeleting(null);
              await refetch();
              open({ node: null });
            } catch (e) {
              setError(errorMessage(e, t`Could not delete tag`));
            }
          })();
        }}
      />
    </section>
  );
}
