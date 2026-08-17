/**
 * LlmIndexersViewer — lens at `/dock/lens/fs-records/llm-indexers/`.
 *
 * Lists every MarkdownIndex entity. Each row offers:
 *   • Run    — spawn a rebuild AgenticProcess (kind = markdown_index_rebuild)
 *   • Status — derived from the latest linked AgenticProcess
 *   • View   — open the rendered `index.md` in the markdown viewer
 *
 * Mirrors the existing useSpawnRunner pattern; AgenticProcess is reused as-is.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ListTree, Play, FileText, Loader2, RefreshCw } from 'lucide-react';
import { AgenticProcess, MarkdownIndex, ProcessKind, QueryRequest, dataContext } from '@sdk';
import { ScopeFilterBar } from '@src/components/scope-filter/ScopeFilterBar';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { notify } from '@src/notifications';
import { useDefaultScopeFilter } from '@src/hooks/use-default-scope-filter';
import { scopeIncludesUser, scopeProjectIds } from '@src/lib/scope-filter';
import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** Strip trailing slashes so equal-and-startswith comparisons are stable. */
function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

/** True when ``child`` lives at-or-under ``parent`` (path-segment aware). */
function isInsidePath(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!p) return false;
  return c === p || c.startsWith(p + '/');
}

const toneClasses: Record<'idle' | 'running' | 'done' | 'error', string> = {
  idle: 'bg-muted text-muted-foreground',
  running: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  error: 'bg-destructive/15 text-destructive',
};

export function LlmIndexersViewer() {
  const { navigation } = useDockNavigation();
  const { t } = useLingui();
  const [busyId, setBusyId] = useState<string | null>(null);

  const statusLabel = (
    latestProcessId: string | undefined,
  ): { label: string; tone: 'idle' | 'running' | 'done' | 'error' } => {
    if (!latestProcessId) return { label: t`never run`, tone: 'idle' };
    // The viewer doesn't subscribe to live process status here; the AgenticProcess
    // pointer is enough for "View transcript" navigation. A future iteration can
    // wire useAgenticProcessStatus(latestProcessId) if/when that hook exists.
    return { label: t`has runs`, tone: 'done' };
  };

  const request = useMemo(() => new QueryRequest({ type: MarkdownIndex.type }), []);
  const { data: allIndexes = [], isLoading, refetch } = useEntitiesQuery<MarkdownIndex>(request);

  const [scope, setScope, currentProjectId] = useDefaultScopeFilter();

  // Project mount paths drive the in-scope check: an index whose vault_root
  // lives under a selected project is in-scope; an index whose vault_root
  // is outside every project's mount path is "user-area" and follows scope.user.
  // Project IDs in `scope.projects` are real Project entity ids.
  const { projects: allProjects } = useAllProjects();
  const indexes = useMemo(() => {
    return allIndexes.filter((idx) => {
      const vr = idx.vault_root;
      // Configuration rows with no vault_root: treat as user-area.
      if (!vr) return scopeIncludesUser(scope);
      const matching = allProjects.find((p) => p.cwd && isInsidePath(vr, p.cwd));
      if (matching) return scopeProjectIds(scope).includes(matching.id);
      return scopeIncludesUser(scope);
    });
  }, [allIndexes, allProjects, scope]);

  const runRebuild = useCallback(
    async (index: MarkdownIndex) => {
      if (!index.vault_root) {
        notify.info({
          title: t`Cannot run rebuild`,
          message: t`MarkdownIndex has no vault_root — set the source path first.`,
        });
        return;
      }
      setBusyId(index.id ?? null);
      try {
        const systemSkills = dataContext.bootstrapInfo?.desktop_info?.paths?.system_skills;
        const skillPath = systemSkills
          ? `/${systemSkills}/markdown_index/SKILL.md`
          : '~/.flow/system_assets/skills/markdown_index/SKILL.md';
        const instruction = [
          `Rebuild MarkdownIndex \`${index.typeId.toString()}\`.`,
          `ROOT_PATH=${index.vault_root}`,
          `MARKDOWN_INDEX_TYPEID=${index.typeId.toString()}`,
          `SKILL_DIR=$(dirname "${skillPath}")`,
          `FORCE=false`,
          ``,
          `Follow the markdown_index skill protocol: run plan.py, summarise stale files, assemble stale folders post-order.`,
        ].join('\n');
        const workdir = index.vault_root;
        const process = await AgenticProcess.newHeadless({
          context_data: {
            project_id: dataContext.project?.id,
            kind: 'markdown_index_rebuild',
            markdown_index_id: index.id,
          },
          workdir,
          target_typeid_str: index.typeId.toString(),
          process_type: ProcessKind.Execution,
        }).save([index.typeId]);
        void process.submit(instruction);
        notify.success({
          title: t`Rebuild started`,
          message: t`MarkdownIndex ${index.name ?? index.id} is rebuilding.`,
        });
        await refetch();
      } catch (err) {
        notify.info({
          title: t`Rebuild failed to start`,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusyId(null);
      }
    },
    [refetch],
  );

  const viewIndex = useCallback(
    (index: MarkdownIndex) => {
      if (!index.asset_ref) {
        notify.info({
          title: t`No index.md to view`,
          message: t`asset_ref is unset — has this MarkdownIndex ever been built?`,
        });
        return;
      }
      navigation.openDock(DockPointer.forFs(index.asset_ref));
    },
    [navigation],
  );

  return (
    <div className="flex h-full flex-col" data-testid="llm-indexers-lens">
      <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <ListTree className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">
            <Trans>LLM Indexers</Trans>
          </h1>
          {indexes.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{indexes.length}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ScopeFilterBar scope={scope} currentProjectId={currentProjectId} onScopeChange={setScope} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void refetch()}>
                <RefreshCw className="h-3.5 w-3.5" />
                <Trans>Refresh</Trans>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <Trans>Reload the MarkdownIndex list.</Trans>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : indexes.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <p>
              <Trans>No MarkdownIndex entities yet.</Trans>
            </p>
            <p className="text-xs">
              <Trans>
                Create one by dropping an <code>index.md</code> with <code>type: markdown_index</code> frontmatter into
                a docs folder and running <code>flow record index &lt;path&gt;</code>.
              </Trans>
            </p>
          </div>
        ) : (
          <table className="w-full text-sm" data-testid="llm-indexers-table">
            <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2 text-start font-medium">
                  <Trans>Name</Trans>
                </th>
                <th className="px-4 py-2 text-start font-medium">
                  <Trans>Vault root</Trans>
                </th>
                <th className="px-4 py-2 text-end font-medium">
                  <Trans>Files</Trans>
                </th>
                <th className="px-4 py-2 text-end font-medium">
                  <Trans>Subfolders</Trans>
                </th>
                <th className="px-4 py-2 text-start font-medium">
                  <Trans>Status</Trans>
                </th>
                <th className="px-4 py-2 text-end font-medium">
                  <Trans>Actions</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {indexes.map((idx) => {
                const status = statusLabel(idx.latest_process_ref);
                const isBusy = busyId === idx.id;
                return (
                  <tr key={idx.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-2 font-medium">{idx.title || idx.name || idx.id}</td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{idx.vault_root || '—'}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{idx.file_count ?? 0}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{idx.subfolder_count ?? 0}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClasses[status.tone]}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1.5 text-xs"
                              onClick={() => void runRebuild(idx)}
                              disabled={isBusy}
                              data-testid={`llm-indexer-run-${idx.id}`}
                            >
                              {isBusy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Play className="h-3.5 w-3.5" />
                              )}
                              {isBusy ? <Trans>Starting…</Trans> : <Trans>Run</Trans>}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <Trans>Spawn an AgenticProcess to (re)build this index.</Trans>
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1.5 text-xs"
                              onClick={() => viewIndex(idx)}
                              data-testid={`llm-indexer-view-${idx.id}`}
                            >
                              <FileText className="h-3.5 w-3.5" />
                              <Trans>View</Trans>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <Trans>Open the rendered index.md.</Trans>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </ScrollArea>
    </div>
  );
}
