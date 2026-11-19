import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChartBar, Check, Loader2, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { FlowMessage, TypeId } from '@sdk';
import type { MessageClassification } from '@sdk/entities/flow-message';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { KindValue } from '@src/components/value-viewer/KindValue';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { useTagColors } from './MessageTags';
import { TagOffIcon } from './TagOffIcon';
import { messageLabel, TagChip } from './tag-chip';

/** Dry runs in flight at once: enough to fill a table quickly, few enough not to flood the decision API. */
const AT_ONCE = 4;

type Row = { answer?: MessageClassification; error?: string; applied?: boolean };

/** The tag a dry run landed on: a name, '' for "no tag fits", undefined while running or when it failed. */
const landedOn = (row: Row | undefined) => (row?.answer?.exit_code === 0 ? (row.answer.value?.tag ?? '') : undefined);

/** One dry-run classification per message, side by side with the tags it has now. Nothing is tagged until a
 *  person applies a row, and applying starts no automation. */
export function ClassifyDialog({ messageIds, onClose }: { messageIds: string[]; onClose: () => void }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The rows whose new tag the message does not carry yet — each row reads its message and reports it. */
  const [changing, setChanging] = useState<Set<string>>(new Set());
  const ids = useMemo(() => [...new Set(messageIds)], [messageIds]);
  const colors = useTagColors();

  useEffect(() => {
    let live = true;
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id && live; id = queue.shift()) {
        const row: Row = await FlowMessage.classifyById(id).then(
          (answer) => ({ answer }),
          (e: unknown) => ({ error: errorMessage(e, t`Could not classify`) }),
        );
        if (live) setRows((all) => ({ ...all, [id!]: row }));
      }
    };
    for (let i = 0; i < AT_ONCE; i += 1) void worker();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per opened table
  }, [ids]);

  const changes = (id: string) => changing.has(id);
  const report = (id: string, on: boolean) =>
    setChanging((all) => {
      if (all.has(id) === on) return all;
      const next = new Set(all);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const apply = async (which: string[]) => {
    setError(null);
    await Promise.all(
      which.filter(changes).map((id) =>
        FlowMessage.applyClassification(id, landedOn(rows[id])!).then(
          () => setRows((all) => ({ ...all, [id]: { ...all[id], applied: true } })),
          (e: unknown) => setError(errorMessage(e, t`Could not apply`)),
        ),
      ),
    );
    setTicked(new Set());
  };

  const done = ids.filter((id) => rows[id]).length;
  const failed = ids.filter((id) => rows[id] && landedOn(rows[id]) === undefined).length;
  const applied = ids.filter((id) => rows[id]?.applied).length;
  const wouldChange = ids.filter(changes).length;
  const allTicked = ids.length > 0 && ids.every((id) => ticked.has(id));
  const tick = (id: string) =>
    setTicked((all) => {
      const next = new Set(all);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-5xl" data-testid="classify-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Classify {ids.length} messages</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>A dry run: nothing is tagged until you apply, and no automation starts.</Trans>
          </DialogDescription>
        </DialogHeader>
        {ticked.size > 0 && (
          <div
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1"
            data-testid="classify-selection-bar"
          >
            <span className="me-1 text-xs text-muted-foreground">
              <Trans>{ticked.size} selected</Trans>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={![...ticked].some(changes)}
              title={t`Make the new tags the messages' tags. No automation runs.`}
              onClick={() => void apply([...ticked])}
              data-testid="classify-selection-apply"
            >
              <Check className="me-1 h-3.5 w-3.5" />
              <Trans>Apply</Trans>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="ms-auto h-7 w-7"
              title={t`Clear selection`}
              onClick={() => setTicked(new Set())}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
          <Table data-testid="classify-table">
            <TableHeader>
              <TableRow className="text-xs hover:bg-transparent">
                <TableHead className="h-9 w-7 ps-3">
                  <Checkbox
                    checked={allTicked ? true : ticked.size > 0 ? 'indeterminate' : false}
                    onCheckedChange={() => setTicked(allTicked ? new Set() : new Set(ids))}
                    aria-label={t`Select all`}
                    className="h-3.5 w-3.5 border-muted-foreground"
                  />
                </TableHead>
                <TableHead className="h-9 px-3">
                  <Trans>Conversation</Trans>
                </TableHead>
                <TableHead className="h-9 px-3">
                  <Trans>Current tags</Trans>
                </TableHead>
                <TableHead className="h-9 px-3">
                  <Trans>New tags</Trans>
                </TableHead>
                <TableHead className="h-9" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ids.map((id) => (
                <ClassifyRow
                  key={id}
                  id={id}
                  row={rows[id]}
                  colors={colors}
                  ticked={ticked.has(id)}
                  opened={opened === id}
                  onChanges={(on) => report(id, on)}
                  onTick={() => tick(id)}
                  onApply={() => void apply([id])}
                  onWhy={() => setOpened(opened === id ? null : id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground" data-testid="classify-summary">
            {done < ids.length ? (
              <Trans>
                {done} of {ids.length} classified
              </Trans>
            ) : applied ? (
              <Trans>{applied} applied · no automation started</Trans>
            ) : (
              <Trans>
                {done} classified · {wouldChange} would change · {failed} failed
              </Trans>
            )}
          </span>
          <Button variant="outline" size="sm" onClick={onClose} data-testid="classify-close">
            <Trans>Close</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ClassifyRow({
  id,
  row,
  colors,
  ticked,
  opened,
  onChanges,
  onTick,
  onApply,
  onWhy,
}: {
  id: string;
  row: Row | undefined;
  colors: Map<string, string | null | undefined>;
  ticked: boolean;
  opened: boolean;
  onChanges: (changes: boolean) => void;
  onTick: () => void;
  onApply: () => void;
  onWhy: () => void;
}) {
  const { t } = useLingui();
  const message = useEntity<FlowMessage>(new TypeId(FlowMessage.type, id)).data;
  const tags = message?.tags ?? [];
  const [who, what] = messageLabel(message);
  const landed = landedOn(row);
  const changes = !!landed && !!message && !tags.includes(landed);
  useEffect(() => onChanges(changes), [changes]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = row?.answer?.run;
  const none = <TagOffIcon className="size-3 text-muted-foreground" aria-label={t`No tags`} />;
  return (
    <Fragment>
      <TableRow className={cn(ticked && 'bg-primary/10')} data-testid={`classify-row-${id}`}>
        <TableCell className="w-7 ps-3">
          <Checkbox
            checked={ticked}
            onCheckedChange={onTick}
            aria-label={t`Select conversation`}
            className="h-3.5 w-3.5 border-muted-foreground"
          />
        </TableCell>
        <TableCell className="max-w-md px-3">
          <div className="truncate">
            <b>{who}</b>
            <span className="text-muted-foreground"> — {what}</span>
          </div>
        </TableCell>
        <TableCell className="px-3">
          <div className="flex flex-wrap items-center gap-1" data-testid="classify-row-current">
            {tags.length ? tags.map((tag) => <TagChip key={tag} name={tag} color={colors.get(tag)} />) : none}
          </div>
        </TableCell>
        <TableCell className="px-3">
          <div className="flex items-center gap-1.5 whitespace-nowrap" data-testid="classify-row-new">
            {!row ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                <Trans>Classifying…</Trans>
              </span>
            ) : landed === undefined ? (
              <span className="text-xs text-destructive">{row.error ?? row.answer?.detail}</span>
            ) : (
              <>
                {landed ? (
                  <TagChip name={landed} color={colors.get(landed)} />
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    {none}
                    <Trans>no tag fits</Trans>
                  </span>
                )}
                {row.applied ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
                    <Check className="size-3" />
                    <Trans>applied</Trans>
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    {Math.round((row.answer?.value?.confidence ?? 0) * 100)}%
                  </span>
                )}
                {changes && (
                  <>
                    <span className="text-[11px] font-medium text-primary">
                      <Trans>changed</Trans>
                    </span>
                    <button
                      type="button"
                      title={t`Make this the message's tag. No automation runs.`}
                      onClick={onApply}
                      data-testid="classify-row-apply"
                      className="ms-1 inline-flex h-6 items-center rounded-md border border-border px-2 text-[11px] font-medium hover:bg-accent hover:text-accent-foreground"
                    >
                      <Trans>Apply</Trans>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </TableCell>
        <TableCell className="w-16 text-end">
          {run && (
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
          )}
        </TableCell>
      </TableRow>
      {opened && run && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={5} className="p-4">
            <KindValue kind="decision.run" value={run} testId="classify-row-run" />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
