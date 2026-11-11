/**
 * Projects status & cleanup — what every project is, and what removing it costs.
 *
 * The screen exists because the picker shows a name and nothing else, so a
 * thousand leftover harness folders are indistinguishable from real work. Here
 * each row carries the evidence: which harness used it, whether it is a git
 * repo, when it last changed, and how many files it holds.
 *
 * Three rules shape the layout, each a correction to a first cut that read
 * badly on screen:
 *
 * * **The actions are always on screen.** They used to render only once rows
 *   were selected, so the page opened with no cleanup affordance at all and no
 *   hint that selecting a row would produce one. A disabled button that says
 *   why is discoverable; an absent button is not.
 * * **Columns are labelled.** With no header row, `0`, `—` and `Aug 15` are
 *   unreadable — nothing tells a file count from a session count from a date.
 * * **One kind of project at a time.** Stacked sections buried the interesting
 *   rows under fourteen dull ones. Each kind gets a tab carrying its own count,
 *   and the tab is also the scope: select-all means "all of these".
 *
 * Nothing is ever pre-selected. The verdict is advisory; a person picks rows.
 */

import { msg, plural } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Checkbox } from '@src/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { cn } from '@src/lib/utils';
import { formatBytes } from '@src/utils/format-bytes';
import { useAgentContext } from '@src/contexts/agent-context';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import {
  deleteProjectsPermanently,
  getProjectCleanupReport,
  getProjectGitDetail,
  removeProjectsFromHarness,
  type CleanupApplyResponse,
  type GitInfo,
  type ProjectCleanupItem,
  type CleanupVerdict,
} from '@sdk/entities/compute-node/system-profile';
import { AlertTriangle, ChevronDown, ChevronRight, FolderX, GitBranch, RefreshCw, Trash2, Unplug } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Above this many files a row is flagged: it holds real work, whatever the verdict. */
const CONTENT_WARNING_FILES = 4;

interface TabSpec {
  verdict: CleanupVerdict;
  label: MessageDescriptor;
  hint: MessageDescriptor;
}

/**
 * Ordered by how safe the group is to remove, which is also how likely it is to
 * be why someone opened the page. `empty` leads rather than `orphaned` because
 * it is the large pile; missing folders are a rounding error beside it.
 */
const TABS: TabSpec[] = [
  {
    verdict: 'empty',
    label: msg`Empty`,
    hint: msg`No sessions, no files, untouched for over a week. Safe to remove.`,
  },
  {
    verdict: 'stale',
    label: msg`Has files`,
    hint: msg`No sessions, but something is in the folder or it changed recently.`,
  },
  {
    verdict: 'active',
    label: msg`In use`,
    hint: msg`A harness has sessions here, or the project was opened recently.`,
  },
  {
    verdict: 'orphaned',
    label: msg`Missing folder`,
    hint: msg`The folder is already gone. Only the Flowpad project remains.`,
  },
];

/** Shared formatter, plus this screen's "no bytes at all" glyph — the same
 *  wrapper the sibling scanner lens uses, so sizes agree across the app. */
function fmtBytes(bytes: number): string {
  return bytes ? formatBytes(bytes) : '—';
}

function whenever(iso: string | null, justNow: string): string {
  if (!iso) return '—';
  return formatTimeAgo(iso) || justNow;
}

/** One source for every column width, so a cell cannot drift from its label. */
const COL = {
  check: 'w-4',
  chevron: 'w-3',
  harness: 'w-36',
  git: 'w-10',
  updated: 'w-24',
  files: 'w-16',
  size: 'w-16',
};

function ColumnHeader() {
  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      <span className={cn(COL.check, 'shrink-0')} />
      <span className={cn(COL.chevron, 'shrink-0')} />
      <span className="min-w-0 flex-1">
        <Trans>Project</Trans>
      </span>
      <span className={cn(COL.harness, 'shrink-0')}>
        <Trans>Harness · sessions</Trans>
      </span>
      <span className={cn(COL.git, 'shrink-0 text-center')}>
        <Trans>Git</Trans>
      </span>
      <span className={cn(COL.updated, 'shrink-0 text-end')}>
        <Trans>Updated</Trans>
      </span>
      <span className={cn(COL.files, 'shrink-0 text-end')}>
        <Trans>Files</Trans>
      </span>
      <span className={cn(COL.size, 'shrink-0 text-end')}>
        <Trans>Size</Trans>
      </span>
    </div>
  );
}

interface RowProps {
  item: ProjectCleanupItem;
  selected: boolean;
  onToggle: (id: string) => void;
  computeNodeId: string | undefined;
}

/** Memoized: every prop is already stable (the item comes from a memoized list,
 *  `onToggle` from a `useCallback`), so without this one checkbox click
 *  re-renders every row in the tab. */
const CleanupRow = memo(function CleanupRow({ item, selected, onToggle, computeNodeId }: RowProps) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [git, setGit] = useState<GitInfo | null>(item.git);
  // Asked-once latch. `git.resolved` says whether the ANSWER is complete, which
  // is what the UI renders on; this says whether we have already asked, which is
  // what the fetch keys on. They are not the same question: a backend that does
  // not send `resolved` would otherwise leave the condition permanently true and
  // refetch on every render forever.
  const asked = useRef(false);

  // Remote and dirty cost a subprocess pair each, so they are resolved for the
  // one row a person opened rather than for the whole listing.
  useEffect(() => {
    if (!expanded || !computeNodeId || asked.current || !item.git?.has_repo) return;
    asked.current = true;
    let alive = true;
    void getProjectGitDetail(computeNodeId, item.cwd).then((detail) => {
      // An older backend omits `resolved`; treat a returned answer as resolved
      // rather than leaving the row reading "checking…" forever.
      if (alive) setGit({ ...detail, resolved: detail.resolved ?? true });
    });
    return () => {
      alive = false;
    };
  }, [expanded, computeNodeId, item.cwd, item.git?.has_repo]);

  const heavy = item.file_count >= CONTENT_WARNING_FILES;
  const sessions = item.harnesses.reduce((total, use) => total + use.session_count, 0);
  const justNow = t`just now`;
  const itemName = item.name;
  const lastSession = whenever(item.modified_at, justNow);
  const lastOpened = whenever(item.last_active_at, justNow);
  const remote = git?.remote || t`none`;
  const harnessNames = item.harnesses.map((use) => use.harness).join(', ');

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-2 border-b px-3 py-1.5 text-xs hover:bg-muted/30',
          selected && 'bg-accent/20',
        )}
      >
        <Checkbox
          className={cn(COL.check, 'shrink-0')}
          checked={selected}
          onCheckedChange={() => onToggle(item.project_id)}
          aria-label={t`Select ${itemName}`}
        />
        <button
          onClick={() => setExpanded((open) => !open)}
          className={cn(COL.chevron, 'shrink-0 text-muted-foreground hover:text-foreground')}
          aria-label={expanded ? t`Collapse` : t`Expand`}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>

        <span className="min-w-0 flex-1 truncate font-medium" title={item.cwd}>
          {item.name}
        </span>

        <span className={cn(COL.harness, 'flex shrink-0 gap-1 text-[10px] text-muted-foreground')}>
          {item.harnesses.length === 0 ? (
            <span className="opacity-60">—</span>
          ) : (
            item.harnesses.map((use) => (
              <Badge key={use.harness} variant="secondary" className="text-[10px]">
                {use.harness} {use.session_count}
              </Badge>
            ))
          )}
        </span>

        <span className={cn(COL.git, 'shrink-0 text-center')}>
          {item.git?.has_repo ? (
            <GitBranch className="mx-auto h-3 w-3 text-muted-foreground" />
          ) : (
            <span className="text-muted-foreground opacity-50">—</span>
          )}
        </span>

        <span className={cn(COL.updated, 'shrink-0 text-end tabular-nums text-muted-foreground')}>
          {whenever(item.dir_modified_at, justNow)}
        </span>

        <span
          className={cn(
            COL.files,
            'flex shrink-0 items-center justify-end gap-1 tabular-nums',
            heavy ? 'font-medium text-amber-600 dark:text-amber-500' : 'text-muted-foreground',
          )}
          title={heavy ? t`This folder holds files` : undefined}
        >
          {heavy && <AlertTriangle className="h-3 w-3" />}
          {item.file_count_capped ? `${item.file_count}+` : item.file_count}
        </span>

        <span className={cn(COL.size, 'shrink-0 text-end tabular-nums text-muted-foreground')}>
          {fmtBytes(item.size_bytes)}
        </span>
      </div>

      {expanded && (
        <div className="border-b bg-muted/20 px-3 py-2 ps-12 text-[11px] text-muted-foreground">
          <div className="font-mono">{item.cwd}</div>
          <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
            <span>
              <Trans>sessions: {sessions}</Trans>
            </span>
            <span>
              <Trans>last session: {lastSession}</Trans>
            </span>
            <span>
              <Trans>last opened: {lastOpened}</Trans>
            </span>
            {git?.has_repo &&
              (git.resolved ? (
                <>
                  <span>
                    <Trans>remote: {remote}</Trans>
                  </span>
                  <span>{git.dirty ? <Trans>uncommitted changes</Trans> : <Trans>clean</Trans>}</span>
                </>
              ) : (
                // Saying "clean" before the check has run would be a claim about
                // the user's uncommitted work that we have not verified.
                <span>
                  <Trans>git repo — checking…</Trans>
                </span>
              ))}
          </div>
          {item.harnesses.length > 0 && (
            <div className="mt-1">
              <Trans>clearing harness history removes sessions for: {harnessNames}</Trans>
            </div>
          )}
        </div>
      )}
    </>
  );
});

interface Props {
  /** Optional project id to focus — passed by the picker's info icon. */
  focusProjectId?: string;
}

export function ProjectCleanupViewer({ focusProjectId }: Props) {
  const { t, i18n } = useLingui();
  const { computeNode } = useAgentContext();
  const [items, setItems] = useState<ProjectCleanupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<CleanupVerdict>('empty');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<'harness' | 'delete' | null>(null);
  const [outcome, setOutcome] = useState<CleanupApplyResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!computeNode?.id) return;
    setLoading(true);
    try {
      const report = await getProjectCleanupReport(computeNode.id);
      setItems(report.projects);
    } finally {
      setLoading(false);
    }
  }, [computeNode?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const byVerdict = useMemo(() => {
    const out = new Map<CleanupVerdict, ProjectCleanupItem[]>();
    for (const spec of TABS) out.set(spec.verdict, []);
    for (const item of items) out.get(item.verdict)?.push(item);
    return out;
  }, [items]);

  // A project arriving from the picker's info icon opens its own tab and starts
  // selected, so the row the user asked about is on screen rather than filed
  // behind whichever tab happened to be first.
  const focusHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!focusProjectId || focusHandled.current === focusProjectId) return;
    const found = items.find((item) => item.project_id === focusProjectId);
    if (!found) return;
    // One-shot. `items` gets a new identity from every reload, including the one
    // after each action — without the guard, finishing a delete would re-select
    // the focused project and yank the user back to its tab.
    focusHandled.current = focusProjectId;
    setTab(found.verdict);
    setSelected(new Set([focusProjectId]));
  }, [focusProjectId, items]);

  // Memoized: the `?? []` fallback builds a fresh array on every render, so
  // without this the selection memo and select-all callback below re-create
  // themselves each pass and every row re-renders on any state change.
  const rows = useMemo(() => byVerdict.get(tab) ?? [], [byVerdict, tab]);

  // Selection is scoped to the visible tab. A checkbox the reader cannot see is
  // one they cannot untick, so no action may ever act on it.
  const selectedRows = useMemo(() => rows.filter((item) => selected.has(item.project_id)), [rows, selected]);
  // Gate on whether a harness CLAIMS the project, not on `state_paths`: the
  // listing omits those on purpose (resolving them means scanning the harness
  // stores per project), so gating on them disables the button for every row.
  // The backend resolves the paths when the action runs and refuses per project
  // if there turn out to be none.
  const selectedWithHarness = useMemo(() => selectedRows.filter((item) => item.harnesses.length > 0), [selectedRows]);
  const selectedWithFilesCount = useMemo(
    () => selectedRows.filter((item) => item.file_count > 0).length,
    [selectedRows],
  );
  const allShownSelected = rows.length > 0 && selectedRows.length === rows.length;

  const toggle = useCallback((id: string) => {
    setSelected((held) => {
      const next = new Set(held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllShown = useCallback(() => {
    setSelected((held) => {
      const next = new Set(held);
      for (const item of rows) {
        if (allShownSelected) next.delete(item.project_id);
        else next.add(item.project_id);
      }
      return next;
    });
  }, [rows, allShownSelected]);

  const switchTab = useCallback((next: CleanupVerdict) => {
    setTab(next);
    // Selection does not survive a tab change: carrying an unseen selection into
    // a delete is exactly the accident this page must not enable.
    setSelected(new Set());
    setOutcome(null);
  }, []);

  const apply = useCallback(
    async (kind: 'harness' | 'delete') => {
      if (!computeNode?.id) return;
      // Clearing harness history runs over the rows that HAVE one, not the whole
      // selection — sending the rest would collect a refusal per row and report
      // failures for projects the dialog never claimed it would touch.
      const ids =
        kind === 'harness'
          ? selectedWithHarness.map((item) => item.project_id)
          : selectedRows.map((item) => item.project_id);
      if (ids.length === 0) return;
      setBusy(true);
      try {
        const result =
          kind === 'delete'
            ? await deleteProjectsPermanently(computeNode.id, ids)
            : await removeProjectsFromHarness(computeNode.id, ids);
        setOutcome(result);
        setSelected(new Set());
        await load();
      } finally {
        setBusy(false);
      }
    },
    [computeNode?.id, selectedRows, selectedWithHarness, load],
  );

  const nothingSelected = selectedRows.length === 0;
  /** Why clearing is unavailable, in the user's terms. Empty ⇒ available. */
  const harnessBlocked = nothingSelected
    ? t`Select a project first`
    : selectedWithHarness.length === 0
      ? t`None of the selected projects has harness history`
      : '';

  const activeTab = TABS.find((spec) => spec.verdict === tab);
  const tabLabel = activeTab ? i18n._(activeTab.label).toLowerCase() : '';
  const selectedCount = selectedRows.length;
  const rowCount = rows.length;
  const harnessCount = selectedWithHarness.length;
  const untouchedCount = selectedRows.length - selectedWithHarness.length;
  const succeededCount = outcome?.succeeded ?? 0;
  const failedCount = outcome?.failed ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Title */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <FolderX className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          <Trans>Projects status &amp; cleanup</Trans>
        </span>
        <Badge variant="secondary" className="text-[10px]">
          {items.length}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          onClick={() => void load()}
          aria-label={t`Refresh`}
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* One kind of project per tab, each carrying its own count. Radix rather
          than hand-rolled buttons, so arrow-key roving and the aria wiring come
          for free instead of being maintained here. */}
      <Tabs value={tab} onValueChange={(next) => switchTab(next as CleanupVerdict)}>
        <TabsList className="h-auto w-full justify-start rounded-none border-b bg-transparent p-0 px-2 pt-1">
          {TABS.map((spec) => {
            const count = byVerdict.get(spec.verdict)?.length ?? 0;
            return (
              <TabsTrigger
                key={spec.verdict}
                value={spec.verdict}
                className="gap-1.5 rounded-t border-b-2 border-transparent px-3 py-1.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:shadow-none"
              >
                {i18n._(spec.label)}
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {count}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {/* What this tab means, and what can be done with it. The actions are
          always rendered — disabled with a reason, never absent. */}
      <div className="flex items-center gap-3 border-b bg-muted/20 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {activeTab ? i18n._(activeTab.hint) : null}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {selectedCount > 0 ? t`${selectedCount} selected` : t`none selected`}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1 text-xs"
          disabled={busy || !!harnessBlocked}
          title={harnessBlocked || t`Delete the harness session history, keeping the folder`}
          onClick={() => setConfirming('harness')}
        >
          <Unplug className="h-3 w-3" />
          <Trans>Clear harness history</Trans>
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 shrink-0 gap-1 text-xs"
          disabled={busy || nothingSelected}
          title={nothingSelected ? t`Select a project first` : t`Move the folder to the Trash and remove the project`}
          onClick={() => setConfirming('delete')}
        >
          <Trash2 className="h-3 w-3" />
          <Trans>Move to Trash</Trans>
        </Button>
      </div>

      {outcome && (
        <div className="border-b bg-muted/30 px-3 py-1.5 text-xs">
          <Trans>{succeededCount} done</Trans>
          {failedCount > 0 ? t`, ${failedCount} refused` : ''}
          {outcome.results.some((r) => r.trashed) && (
            <span className="ms-2 text-muted-foreground">
              <Trans>Folders are in your Trash.</Trans>
            </span>
          )}
          {outcome.results
            .filter((r) => !r.ok)
            .slice(0, 3)
            .map((r) => (
              <span key={r.project_id} className="ms-2 text-muted-foreground">
                {r.error}
              </span>
            ))}
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-auto">
        {loading && items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Trans>Reading projects…</Trans>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Trans>No {tabLabel} projects.</Trans>
          </div>
        ) : (
          <>
            {/* Select-all sits above the header so its scope reads as "this tab". */}
            <div className="flex items-center gap-2 border-b px-3 py-1 text-[11px] text-muted-foreground">
              <Checkbox
                className={cn(COL.check, 'shrink-0')}
                checked={allShownSelected}
                onCheckedChange={toggleAllShown}
                aria-label={t`Select all ${tabLabel} projects`}
              />
              <span>
                <Trans>Select all {rowCount}</Trans>
              </span>
            </div>
            <ColumnHeader />
            {rows.map((item) => (
              <CleanupRow
                key={item.project_id}
                item={item}
                selected={selected.has(item.project_id)}
                onToggle={toggle}
                computeNodeId={computeNode?.id}
              />
            ))}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirming === 'harness'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={plural(harnessCount, {
          one: 'Clear harness history for # project?',
          other: 'Clear harness history for # projects?',
        })}
        description={
          selectedWithHarness.length < selectedRows.length
            ? t`Deletes the harness's own session history. The folders and their files are not touched. ${untouchedCount} of the selected projects have no harness history and are left alone.`
            : t`Deletes the harness's own session history. The folders and their files are not touched.`
        }
        confirmLabel={t`Clear history`}
        onConfirm={() => void apply('harness')}
      />

      <ConfirmDialog
        open={confirming === 'delete'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={plural(selectedCount, {
          one: 'Move # folder to the Trash?',
          other: 'Move # folders to the Trash?',
        })}
        description={
          // Trash is recoverable, so this must not claim otherwise — but a
          // selection holding real files still deserves to be named out loud.
          selectedWithFilesCount > 0
            ? t`${selectedWithFilesCount} of them contain files. The folders go to your Trash and their Flowpad projects are removed; you can restore them from Finder.`
            : t`The folders go to your Trash and their Flowpad projects are removed. You can restore them from Finder.`
        }
        confirmLabel={t`Move to Trash`}
        variant="destructive"
        onConfirm={() => void apply('delete')}
      />
    </div>
  );
}
