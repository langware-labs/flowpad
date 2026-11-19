import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChartBar, Check, GitCompareArrows, Loader2, Tag as TagIcon, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Conversation, FlowMessage, tagIsWithin, TypeId } from '@sdk';
import type { ClassificationRun, ConversationTagging, StreamInboxClassification, TagTreeChange } from '@sdk/entities/flow-message';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { MessageTags, treeRows, useTagColors, useTagDefinitions } from './MessageTags';
import { TagOffIcon } from './TagOffIcon';
import { TagChip } from './tag-chip';

/** How often a run still at work is read again. */
const READ_EVERY_MS = 2000;
const OPS = ['added', 'updated', 'moved', 'removed'] as const;
const countOf = (changes: TagTreeChange[], op: TagTreeChange['op']) => changes.filter((change) => change.op === op).length;
const CHANGE_COLOR: Record<TagTreeChange['op'], string> = {
  added: 'hsl(142 70% 45%)',
  updated: 'hsl(var(--primary))',
  moved: 'hsl(38 92% 50%)',
  removed: 'hsl(var(--destructive))',
};
const CHANGE_MARK: Record<TagTreeChange['op'], string> = { added: '+', updated: '~', moved: '→', removed: '−' };

/** A classification run lives in the URL (`classify=<call id>`): started here, reopened by a reload, closed
 *  by dropping the option. The run itself is durable — closing the table does not stop it. */
export function useClassifyRun() {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const set = (callId: string | null) => currentDock && navigation.openDock(currentDock.withOption('classify', callId));
  return {
    callId: currentDock?.options?.classify || null,
    start: (conversations: string[]) => {
      void FlowMessage.classifyConversations(conversations).then(
        (run) => set(run.call_id),
        (e: unknown) => notify.error({ title: t`Could not start the classification`, message: errorMessage(e, t`It did not work`), forceToast: true }),
      );
    },
    close: () => set(null),
  };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((tag) => b.includes(tag));

/** One agent per conversation proposes its tag; the main agent keeps the tag tree small. Nothing is tagged
 *  until a person applies a row, a selection, or all of it — and applying starts no automation. */
export function ClassifyDialog({ callId, onClose }: { callId: string; onClose: () => void }) {
  const { t } = useLingui();
  const colors = useTagColors();
  const { data: run, error: readError } = useQuery<ClassificationRun>({
    queryKey: ['tags', 'classification-run', callId],
    queryFn: () => FlowMessage.classificationRun(callId),
    retry: false,
    // Read again while it is at work; a run that cannot be read (a stale id in the URL) is not asked again.
    refetchInterval: ({ state }) => (state.status !== 'error' && (!state.data || state.data.state === 'running') ? READ_EVERY_MS : false),
  });
  const value = run?.state === 'completed' && run.result?.exit_code === 0 ? (run.result.value ?? null) : null;
  const asked = (run?.input as { conversations?: string[] } | null | undefined)?.conversations ?? [];
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<string | null>(null);
  const [tree, setTree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** conversation id -> the proposal is on the message (each row reads its message and reports it). */
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const [treeDone, setTreeDone] = useState(false);
  const rows = value?.conversations ?? [];
  const open = rows.filter((row) => !rejected.has(row.conversation_id) && applied[row.conversation_id] === false);
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const apply = async (conversations: string[] | undefined, withTree: boolean) => {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const done = await FlowMessage.applyStreamInboxClassification(value, { conversations, tree: withTree });
      const failed = Object.values(done.failed);
      if (failed.length) setError(failed[0]);
      if (withTree) setTreeDone(true);
      setTicked(new Set());
    } catch (e) {
      setError(errorMessage(e, t`Could not apply`));
    }
    setBusy(false);
  };

  const failure =
    readError || (run && run.state !== 'running' && !value)
      ? errorMessage(readError, run?.error || run?.result?.detail || t`The classification did not finish.`)
      : null;
  const changing = rows.filter((row) => row.action !== 'keep').length;
  const done = rows.filter((row) => applied[row.conversation_id]).length;
  const allTicked = open.length > 0 && open.every((row) => ticked.has(row.conversation_id));

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-5xl" data-testid="classify-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Classify {value ? rows.length : asked.length} conversations</Trans>
          </DialogTitle>
          <DialogDescription>
            {value ? (
              <Trans>A proposal: nothing is tagged until you apply, and no automation starts. What you apply is ground truth.</Trans>
            ) : (
              <Trans>One agent reads each conversation and proposes its tag. A new tag needs the main agent’s approval.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        {ticked.size > 0 && (
          <div className="flex items-center gap-1 rounded-md border border-border px-2 py-1" data-testid="classify-selection-bar">
            <span className="me-1 text-xs text-muted-foreground">
              <Trans>{ticked.size} selected</Trans>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => void apply([...ticked], false)}
              data-testid="classify-selection-apply"
            >
              <Check className="me-1 h-3.5 w-3.5" />
              <Trans>Apply</Trans>
            </Button>
            <Button variant="ghost" size="icon" className="ms-auto h-7 w-7" title={t`Clear selection`} onClick={() => setTicked(new Set())}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        <div className="relative">
          <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
            <Table data-testid="classify-table">
              <TableHeader>
                <TableRow className="text-xs hover:bg-transparent">
                  <TableHead className="h-9 w-7 ps-3">
                    {value && (
                      <Checkbox
                        checked={allTicked ? true : ticked.size > 0 ? 'indeterminate' : false}
                        onCheckedChange={() => setTicked(allTicked ? new Set() : new Set(open.map((row) => row.conversation_id)))}
                        aria-label={t`Select all`}
                        className="h-3.5 w-3.5 border-muted-foreground"
                      />
                    )}
                  </TableHead>
                  <TableHead className="h-9 px-3">
                    <Trans>Conversation</Trans>
                  </TableHead>
                  <TableHead className="h-9 px-3">
                    <Trans>Current</Trans>
                  </TableHead>
                  <TableHead className="h-9 px-3">
                    <Trans>Proposed</Trans>
                  </TableHead>
                  <TableHead className="h-9" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {value
                  ? rows.map((row) => (
                      <ProposedRow
                        key={row.conversation_id}
                        row={row}
                        root={value.root}
                        colors={colors}
                        added={value.tree_changes.some((c) => c.op === 'added' && row.proposed.includes(c.tag))}
                        ticked={ticked.has(row.conversation_id)}
                        rejected={rejected.has(row.conversation_id)}
                        opened={opened === row.conversation_id}
                        busy={busy}
                        onApplied={(on) => setApplied((all) => (all[row.conversation_id] === on ? all : { ...all, [row.conversation_id]: on }))}
                        onTick={() => setTicked(toggle(ticked, row.conversation_id))}
                        onReject={() => {
                          setRejected(toggle(rejected, row.conversation_id));
                          setTicked((all) => new Set([...all].filter((id) => id !== row.conversation_id)));
                        }}
                        onApply={() => void apply([row.conversation_id], false)}
                        onWhy={() => setOpened(opened === row.conversation_id ? null : row.conversation_id)}
                      />
                    ))
                  : asked.map((id) => <WaitingRow key={id} id={id} failed={!!failure} />)}
              </TableBody>
            </Table>
          </div>
          {tree && value && (
            <TreeChanges
              value={value}
              done={treeDone}
              busy={busy}
              onApply={() => void apply([], true)}
            />
          )}
        </div>
        {(error || failure) && (
          <p role="alert" className="text-xs text-destructive" data-testid="classify-error">
            {error || failure}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground" data-testid="classify-summary">
            {value ? (
              <Trans>
                {rows.length} classified · {changing} would change · {done} applied
              </Trans>
            ) : failure ? null : (
              <Trans>Agents are reading — closing keeps it running</Trans>
            )}
          </span>
          <div className="flex items-center gap-2">
            {value && value.tree_changes.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className={cn('gap-1.5', tree && 'bg-accent')}
                onClick={() => setTree(!tree)}
                data-testid="classify-tree-changes"
              >
                <GitCompareArrows className="size-3.5" />
                <Trans>Tag changes</Trans>
                {OPS.map((op) => {
                  const count = countOf(value.tree_changes, op);
                  return count ? (
                    <span key={op} className="text-[11px] font-medium" style={{ color: CHANGE_COLOR[op] }} title={op}>
                      {CHANGE_MARK[op]}
                      {count}
                    </span>
                  ) : null;
                })}
              </Button>
            )}
            {value && open.length > 0 && (
              <Button
                size="sm"
                disabled={busy}
                title={t`Apply every row you did not reject, with the tag changes they need`}
                onClick={() => void apply(open.map((row) => row.conversation_id), true)}
                data-testid="classify-apply-all"
              >
                <Trans>Apply all</Trans>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onClose} data-testid="classify-close">
              <Trans>Close</Trans>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A conversation an agent is still reading. */
function WaitingRow({ id, failed }: { id: string; failed: boolean }) {
  const conversation = useEntity<Conversation>(new TypeId(Conversation.type, id)).data;
  return (
    <TableRow data-testid={`classify-row-${id}`}>
      <TableCell className="w-7 ps-3" />
      <TableCell className="max-w-md px-3">
        <div className="truncate font-semibold">{conversation?.title || '…'}</div>
      </TableCell>
      <TableCell className="px-3" />
      <TableCell className="px-3">
        {!failed && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            <Trans>Classifying…</Trans>
          </span>
        )}
      </TableCell>
      <TableCell className="w-16" />
    </TableRow>
  );
}

function ProposedRow({
  row,
  root,
  colors,
  added,
  ticked,
  rejected,
  opened,
  busy,
  onApplied,
  onTick,
  onReject,
  onApply,
  onWhy,
}: {
  row: ConversationTagging;
  root: string;
  colors: Map<string, string | null | undefined>;
  added: boolean;
  ticked: boolean;
  rejected: boolean;
  opened: boolean;
  busy: boolean;
  onApplied: (applied: boolean) => void;
  onTick: () => void;
  onReject: () => void;
  onApply: () => void;
  onWhy: () => void;
}) {
  const { t } = useLingui();
  const message = useEntity<FlowMessage>(new TypeId(FlowMessage.type, row.message_id)).data;
  const current = useMemo(() => (message?.tags ?? []).filter((tag) => tagIsWithin(tag, root) && tag !== root), [message?.tags, root]);
  // Applied = the message carries the proposal. Read from the message, so a tag a person picks counts too.
  const applied = !!message && same(current, row.proposed);
  useEffect(() => onApplied(applied), [applied, !!message]); // eslint-disable-line react-hooks/exhaustive-deps
  const none = <TagOffIcon className="size-3 text-muted-foreground" aria-label={t`No tags`} />;
  return (
    <Fragment>
      <TableRow className={cn(ticked && 'bg-primary/10')} data-testid={`classify-row-${row.conversation_id}`}>
        <TableCell className="w-7 ps-3">
          {!applied && !rejected && (
            <Checkbox checked={ticked} onCheckedChange={onTick} aria-label={t`Select conversation`} className="h-3.5 w-3.5 border-muted-foreground" />
          )}
        </TableCell>
        <TableCell className="max-w-md px-3">
          <div className="truncate font-semibold">{row.title}</div>
        </TableCell>
        <TableCell className="px-3">
          <div className="flex items-center" data-testid="classify-row-current">
            {/* The message's own tag cell: its menu is how a person picks the tag themselves. */}
            {message ? <MessageTags message={message} compact /> : none}
          </div>
        </TableCell>
        <TableCell className="px-3">
          <div className={cn('flex items-center gap-1.5 whitespace-nowrap', rejected && 'opacity-60')} data-testid="classify-row-new">
            <span className={cn('inline-flex items-center gap-1', rejected && 'line-through')}>
              {row.proposed.length ? (
                row.proposed.map((tag) => <TagChip key={tag} name={tag} color={colors.get(tag)} />)
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  {none}
                  <Trans>no tag fits</Trans>
                </span>
              )}
            </span>
            {applied ? (
              row.action !== 'keep' && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
                  <Check className="size-3" />
                  <Trans>applied</Trans>
                </span>
              )
            ) : rejected ? (
              <span className="text-[11px] font-medium text-muted-foreground">
                <Trans>rejected</Trans>
              </span>
            ) : (
              <span className="text-[11px] font-medium text-primary">{added ? <Trans>new tag</Trans> : <Trans>changed</Trans>}</span>
            )}
            {!applied && !rejected && (
              <button
                type="button"
                disabled={busy}
                title={t`Make this the conversation's tag. No automation runs.`}
                onClick={onApply}
                data-testid="classify-row-apply"
                className="ms-1 inline-flex h-6 items-center rounded-md border border-border px-2 text-[11px] font-medium hover:bg-accent hover:text-accent-foreground"
              >
                <Trans>Apply</Trans>
              </button>
            )}
            {!applied && (
              <button
                type="button"
                title={rejected ? t`Take the proposal back into Apply all` : t`Leave this conversation as it is`}
                onClick={onReject}
                data-testid="classify-row-reject"
                className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[11px] font-medium hover:bg-accent hover:text-accent-foreground"
              >
                {rejected ? <Trans>Undo</Trans> : <Trans>Reject</Trans>}
              </button>
            )}
          </div>
        </TableCell>
        <TableCell className="w-16 text-end">
          <button
            type="button"
            title={t`How it was decided`}
            onClick={onWhy}
            data-testid="classify-row-why"
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-accent hover:text-accent-foreground',
              opened ? 'bg-accent text-foreground' : 'text-muted-foreground',
            )}
          >
            <ChartBar className="size-3.5" />
            <Trans>Why</Trans>
          </button>
        </TableCell>
      </TableRow>
      {opened && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={5} className="p-4">
            <div className="grid grid-cols-[7.5rem_1fr] items-baseline gap-x-4 gap-y-2 text-sm" data-testid="classify-row-trace">
              <div className="text-xs text-muted-foreground">
                <Trans>Agent</Trans>
              </div>
              <div>{row.reason}</div>
              {row.asked && (
                <>
                  <div className="text-xs text-muted-foreground">
                    <Trans>Asked for</Trans>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-foreground/60 px-2 text-[11px]" title={row.asked.tag}>
                      <TagIcon className="size-3" />
                      {row.asked.tag.split('.').at(-1)}
                    </span>
                    <span className="text-xs text-muted-foreground">“{row.asked.meaning}”</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <Trans>Main agent</Trans>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {row.asked.answer === 'approved' ? (
                      <Trans>Approved as a new tag.</Trans>
                    ) : (
                      <>
                        <Trans>Use</Trans>
                        <TagChip name={row.asked.use ?? ''} color={colors.get(row.asked.use ?? '')} />
                        <Trans>instead.</Trans>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

/** The tag tree as the run would leave it: every changed tag says what happened to it, where it happened. */
function TreeChanges({ value, done, busy, onApply }: { value: StreamInboxClassification; done: boolean; busy: boolean; onApply: () => void }) {
  const definitions = useTagDefinitions();
  const colors = useTagColors();
  const byTag = useMemo(() => new Map(value.tree_changes.map((change) => [change.tag, change])), [value.tree_changes]);
  const rows = useMemo(() => {
    const movedFrom = new Set(value.tree_changes.filter((c) => c.op === 'moved').map((c) => c.was));
    const names = definitions.filter((tag) => !tag.deprecated && !movedFrom.has(tag.name)).map((tag) => tag.name ?? '');
    return treeRows([...new Set([...names, ...value.tree_changes.map((c) => c.tag)])], value.root);
  }, [definitions, value]);
  const counts = OPS.map((op) => `${countOf(value.tree_changes, op)} ${op}`).join(' · ');
  return (
    <div
      className="absolute bottom-2 end-2 z-10 max-h-[52vh] w-96 overflow-auto rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
      data-testid="classify-tree-panel"
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          <Trans>Tag tree</Trans>
        </span>
        <span className="text-[11px] text-muted-foreground">{counts}</span>
      </div>
      {rows.map(({ name, depth }) => {
        const change = byTag.get(name);
        return (
          <div key={name} style={{ marginInlineStart: depth * 16 }} data-testid={`classify-tree-row-${name}`} data-change={change?.op}>
            <div className="flex items-center gap-1.5 px-2 py-1 text-sm">
              <TagIcon className="size-3.5 shrink-0" style={{ color: change?.color ?? colors.get(name) ?? undefined }} />
              <span className={cn('truncate', change?.op === 'removed' && 'text-muted-foreground line-through')}>{name.split('.').at(-1)}</span>
              {change && (
                <span className="shrink-0 whitespace-nowrap text-[11px] font-medium" style={{ color: CHANGE_COLOR[change.op] }}>
                  {change.op}
                </span>
              )}
            </div>
            {change && (
              <div className="pb-1 text-[11px] text-muted-foreground" style={{ marginInlineStart: 30 }}>
                {change.op === 'updated' && <div className="line-through">{change.was}</div>}
                {(change.op === 'added' || change.op === 'updated') && <div className="text-foreground">{change.meaning}</div>}
                {change.op === 'moved' && <Trans>was {change.was}</Trans>}
                {change.op === 'removed' && change.merged_into && <Trans>its conversations go to {change.merged_into.split('.').at(-1)}</Trans>}
                <div>{change.reason}</div>
              </div>
            )}
          </div>
        );
      })}
      <div className="mt-2 flex justify-end border-t border-border pt-2">
        {done ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
            <Check className="size-3" />
            <Trans>applied</Trans>
          </span>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={onApply} data-testid="classify-tree-apply">
            <Trans>Apply tag changes</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}
