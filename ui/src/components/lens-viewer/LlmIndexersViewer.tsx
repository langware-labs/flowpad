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
import { ListTree, Play, FileText, Loader2, RefreshCw } from 'lucide-react';
import {
  AgenticProcess,
  MarkdownIndex,
  ProcessType,
  QueryRequest,
  dataContext,
} from '@sdk';
import { ClaudeCliOptions } from '@sdk/cli_workers/claude-cli';
import { ScopeFilterBar } from '@src/components/scope-filter/ScopeFilterBar';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { notify } from '@src/notifications';
import { useDefaultScopeFilter } from '@src/hooks/use-default-scope-filter';
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

function statusLabel(latestProcessId: string | undefined): { label: string; tone: 'idle' | 'running' | 'done' | 'error' } {
  if (!latestProcessId) return { label: 'never run', tone: 'idle' };
  // The viewer doesn't subscribe to live process status here; the AgenticProcess
  // pointer is enough for "View transcript" navigation. A future iteration can
  // wire useAgenticProcessStatus(latestProcessId) if/when that hook exists.
  return { label: 'has runs', tone: 'done' };
}

const toneClasses: Record<'idle' | 'running' | 'done' | 'error', string> = {
  idle:    'bg-muted text-muted-foreground',
  running: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  done:    'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  error:   'bg-destructive/15 text-destructive',
};

export function LlmIndexersViewer() {
  const { navigation } = useDockNavigation();
  const [busyId, setBusyId] = useState<string | null>(null);

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
      if (!vr) return scope.user;
      const matching = allProjects.find((p) => p.cwd && isInsidePath(vr, p.cwd));
      if (matching) return scope.projects.includes(matching.id);
      return scope.user;
    });
  }, [allIndexes, allProjects, scope]);

  const runRebuild = useCallback(async (index: MarkdownIndex) => {
    if (!index.vault_root) {
      notify.info({
        title: 'Cannot run rebuild',
        message: 'MarkdownIndex has no vault_root — set the source path first.',
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
      const cliOptions = new ClaudeCliOptions({
        permission_mode: 'bypassPermissions',
        print_mode: true,
        output_format: 'stream-json',
        verbose: true,
      });
      const process = await new AgenticProcess({
        cli_config: cliOptions.toJson(),
        context_data: {
          project_id: dataContext.project?.id,
          kind: 'markdown_index_rebuild',
          markdown_index_id: index.id,
        },
        workdir,
        visible: false,
        target_typeid_str: index.typeId.toString(),
        process_type: ProcessType.Execution,
      }).save([index.typeId]);
      void process.prompt(instruction);
      notify.success({
        title: 'Rebuild started',
        message: `MarkdownIndex ${index.name ?? index.id} is rebuilding.`,
      });
      await refetch();
    } catch (err) {
      notify.info({
        title: 'Rebuild failed to start',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyId(null);
    }
  }, [refetch]);

  const viewIndex = useCallback((index: MarkdownIndex) => {
    if (!index.asset_ref) {
      notify.info({
        title: 'No index.md to view',
        message: 'asset_ref is unset — has this MarkdownIndex ever been built?',
      });
      return;
    }
    navigation.openDock(DockPointer.forFs(index.asset_ref));
  }, [navigation]);

  return (
    <div className="flex h-full flex-col" data-testid="llm-indexers-lens">
      <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <ListTree className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">LLM Indexers</h1>
          {indexes.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {indexes.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ScopeFilterBar
            scope={scope}
            currentProjectId={currentProjectId}
            onScopeChange={setScope}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void refetch()}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reload the MarkdownIndex list.</TooltipContent>
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
            <p>No MarkdownIndex entities yet.</p>
            <p className="text-xs">
              Create one by dropping an <code>index.md</code> with{' '}
              <code>type: markdown_index</code> frontmatter into a docs folder and
              running <code>flow record index &lt;path&gt;</code>.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm" data-testid="llm-indexers-table">
            <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Vault root</th>
                <th className="px-4 py-2 text-right font-medium">Files</th>
                <th className="px-4 py-2 text-right font-medium">Subfolders</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {indexes.map((idx) => {
                const status = statusLabel(idx.latest_process_ref);
                const isBusy = busyId === idx.id;
                return (
                  <tr key={idx.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-2 font-medium">
                      {idx.title || idx.name || idx.id}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                      {idx.vault_root || '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {idx.file_count ?? 0}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {idx.subfolder_count ?? 0}
                    </td>
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
                              {isBusy ? 'Starting…' : 'Run'}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            Spawn an AgenticProcess to (re)build this index.
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
                              View
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Open the rendered index.md.</TooltipContent>
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
