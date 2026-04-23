import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Settings, X, Wrench } from 'lucide-react';
import { AgenticProcess, Project, QueryRequest } from '@sdk';
import { RecordType } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useAssetSearch, type SearchResult } from '@src/hooks/use-asset-search';
import { useProject } from '@src/hooks/useProject';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@src/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { DEFAULT_ASSET_FILTER, type AssetFilter } from '@src/components/assets/assetFilter';

const ATTACHABLE_TYPES: Array<{ value: string; label: string; icon: typeof Bot }> = [
  { value: RecordType.AGENT, label: 'Agent', icon: Bot },
  { value: RecordType.SKILL, label: 'Skill', icon: Wrench },
];

interface ChatSettingsPopoverProps {
  /**
   * Live attached refs. For a process-backed chat, read from
   * `activeProcess.embedded_asset_refs`. Pre-first-send uses pending state.
   */
  attachedRefs: string[];
  /**
   * Called when the user attaches an entity. For a live process, wire through
   * to `process.embeddedAssets.attach(ref)`. Pre-first-send, push to pending state.
   */
  onAttach: (ref: string) => void | Promise<void>;
  onDetach: (ref: string) => void | Promise<void>;
  /** Active process id, or null before the first send. Gates the project picker. */
  activeProcess: AgenticProcess | null;
  /** Currently-selected project id. */
  projectId: string | null;
  /** Setter for projectId — only callable when activeProcess is null. */
  onProjectChange: (id: string | null) => void;
  /** Trigger button slot injected from the header. */
  trigger: React.ReactNode;
}

/**
 * Popover body: Attached chips + searchable add list + project selector.
 * Reuses `/search` via `useAssetSearch` so the scope toggle + project-scoping
 * come for free.
 */
export function ChatSettingsPopover({
  attachedRefs,
  onAttach,
  onDetach,
  activeProcess,
  projectId,
  onProjectChange,
  trigger,
}: ChatSettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeType, setActiveType] = useState<string>(RecordType.AGENT);
  const { project: currentProject } = useProject();

  const [filter, setFilter] = useState<AssetFilter>({
    ...DEFAULT_ASSET_FILTER,
    scope: 'all',
    projectIds: [],
  });

  const { results, isLoading } = useAssetSearch({
    recordType: open ? activeType : null,
    filter,
    page: 1,
    pageSize: 20,
  });

  const attachedSet = useMemo(() => new Set(attachedRefs), [attachedRefs]);

  const toggleProjectScope = useCallback(
    (only: boolean) => {
      setFilter((f) => ({
        ...f,
        scope: only ? 'project' : 'all',
        projectIds: only && currentProject?.id ? [currentProject.id] : [],
      }));
    },
    [currentProject?.id],
  );

  const projectOnly = filter.scope === 'project';

  const refFromResult = (r: SearchResult): string => `${r.record_type}-${r.record_id}`;

  // Project list — used to populate the selector. Reuses the same query the
  // app uses elsewhere; bounded by the usual entity-query cache.
  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  const { data: projects = [] } = useEntitiesQuery<Project>(projectsQuery, { enabled: open });

  const projectLocked = !!activeProcess;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" data-testid="chat-settings-popover">
        <div className="flex items-center gap-1.5 border-b px-3 py-2">
          <Settings className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Chat settings</span>
        </div>

        {/* ── Attached chips ───────────────────────────────────────────── */}
        <div className="space-y-1.5 border-b px-3 py-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Attached
          </div>
          {attachedRefs.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">Nothing attached yet.</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {attachedRefs.map((ref) => {
                const [type] = ref.split('-');
                return (
                  <span
                    key={ref}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]"
                    data-testid={`chat-settings-attached-${ref}`}
                  >
                    <span className="text-muted-foreground">{type}</span>
                    <span className="max-w-[140px] truncate">{ref.slice(type.length + 1, type.length + 9)}</span>
                    <button
                      type="button"
                      className="rounded hover:bg-background"
                      onClick={() => void onDetach(ref)}
                      title="Detach"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Add ──────────────────────────────────────────────────────── */}
        <div className="space-y-2 border-b px-3 py-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Add
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={projectOnly}
                onChange={(e) => toggleProjectScope(e.target.checked)}
                data-testid="chat-settings-project-only"
              />
              Project only
            </label>
          </div>

          <div className="flex items-center gap-0.5 rounded-md border bg-muted/40 p-0.5">
            {ATTACHABLE_TYPES.map((t) => {
              const Icon = t.icon;
              const active = activeType === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setActiveType(t.value)}
                  className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] ${
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  data-testid={`chat-settings-type-${t.value}`}
                >
                  <Icon className="h-3 w-3" />
                  {t.label}
                </button>
              );
            })}
          </div>

          <input
            type="text"
            placeholder={`Search ${activeType}s…`}
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
            data-testid="chat-settings-search"
          />

          <div className="max-h-56 overflow-y-auto rounded border">
            {isLoading && (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">Searching…</div>
            )}
            {!isLoading && results.length === 0 && (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                {filter.query.length > 0 && filter.query.length < 2
                  ? 'Type at least 2 characters…'
                  : 'No results.'}
              </div>
            )}
            {results.map((r) => {
              const ref = refFromResult(r);
              const attached = attachedSet.has(ref);
              return (
                <label
                  key={ref}
                  className="flex cursor-pointer items-center gap-2 border-b px-2 py-1.5 text-xs last:border-b-0 hover:bg-muted/50"
                  data-testid={`chat-settings-result-${ref}`}
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3 flex-shrink-0"
                    checked={attached}
                    onChange={() => (attached ? void onDetach(ref) : void onAttach(ref))}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{r.name}</div>
                    {r.source_path && (
                      <div className="truncate text-[10px] text-muted-foreground">
                        {r.source_path}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* ── Project ──────────────────────────────────────────────────── */}
        <div className="space-y-1.5 px-3 py-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Project
            </div>
            {projectLocked && (
              <span className="text-[10px] text-muted-foreground">locked after first message</span>
            )}
          </div>
          <Select
            value={projectId ?? ''}
            onValueChange={(v) => onProjectChange(v || null)}
            disabled={projectLocked}
          >
            <SelectTrigger
              className="h-7 text-xs"
              data-testid="chat-settings-project"
              title={projectLocked ? 'Project is fixed after the first message — start a new chat to change it.' : undefined}
            >
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id!}>
                  {p.displayName ?? p.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  );
}
