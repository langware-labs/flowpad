import { useCallback, useMemo, useState } from 'react';
import { AgenticProcess, Agent, Project, QueryRequest, Skill } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useAssetTypes, type AssetTypeInfo } from '@src/hooks/use-asset-types';
import { lucideByName } from '@src/lib/lucide-by-name';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@src/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { ArrowLeft, Plus, Settings, X, type LucideIcon } from 'lucide-react';

/**
 * A single attachable entity we know how to embed into an AgenticProcess.
 * The shape is intentionally flat so the rendering code never has to guess
 * which SDK entity type it's looking at.
 */
interface AttachableEntry {
  ref: string;
  type: 'agent' | 'skill';
  name: string;
  icon: LucideIcon;
}

interface ChatSettingsPopoverProps {
  /** `agent-<id>` / `skill-<id>` strings — serialized TypeIds. */
  attachedRefs: string[];
  onAttach: (ref: string) => void | Promise<void>;
  onDetach: (ref: string) => void | Promise<void>;
  /** Active process id, or null before first send. Locks the project selector. */
  activeProcess: AgenticProcess | null;
  projectId: string | null;
  onProjectChange: (id: string | null) => void;
  trigger: React.ReactNode;
}

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
  const [mode, setMode] = useState<'list' | 'add'>('list');
  const [query, setQuery] = useState('');

  // Cached full lists of agents + skills. Used both for hydrating attached-row
  // display and for populating the add-mode searchable list.
  const agentQuery = useMemo(() => new QueryRequest({ type: Agent.type }), []);
  const skillQuery = useMemo(() => new QueryRequest({ type: Skill.type }), []);
  const { data: agents = [] } = useEntitiesQuery<Agent>(agentQuery, { enabled: open });
  const { data: skills = [] } = useEntitiesQuery<Skill>(skillQuery, { enabled: open });

  // Per-type icon name comes from `_icon: ClassVar[str]` on the record class
  // and is exposed via `GET /api/v1/assets/types`. Resolve the lucide-react
  // export at render time so this stays in sync with the Assets browser.
  const { types: assetTypes } = useAssetTypes();
  const iconForType = useCallback((typeName: string): LucideIcon => {
    const ti = assetTypes.find((t: AssetTypeInfo) => t.type_name === typeName);
    return lucideByName(ti?.icon);
  }, [assetTypes]);

  const attachable: AttachableEntry[] = useMemo(() => {
    const fromAgents = agents.map<AttachableEntry>((a) => ({
      ref: `agent-${a.id}`,
      type: 'agent',
      name: a.name ?? a.id!,
      icon: iconForType('agent'),
    }));
    const fromSkills = skills.map<AttachableEntry>((s) => ({
      ref: `skill-${s.id}`,
      type: 'skill',
      name: s.displayName ?? s.name ?? s.id!,
      icon: iconForType('skill'),
    }));
    return [...fromAgents, ...fromSkills];
  }, [agents, skills, iconForType]);

  const byRef = useMemo(() => {
    const m = new Map<string, AttachableEntry>();
    for (const e of attachable) m.set(e.ref, e);
    return m;
  }, [attachable]);

  const attachedSet = useMemo(() => new Set(attachedRefs), [attachedRefs]);

  // Attached rows (from attachable if hydrated; fall back to ref for unknowns).
  const attachedEntries: AttachableEntry[] = useMemo(() => {
    return attachedRefs.map((ref) => {
      const hit = byRef.get(ref);
      if (hit) return hit;
      const type = (ref.split('-')[0] === 'skill' ? 'skill' : 'agent') as 'agent' | 'skill';
      return { ref, type, name: ref, icon: iconForType(type) };
    });
  }, [attachedRefs, byRef, iconForType]);

  // Add-mode list: attached first (pinned, checked), then rest filtered by query.
  const addListEntries: AttachableEntry[] = useMemo(() => {
    const pinned = attachedEntries;
    const q = query.trim().toLowerCase();
    const rest = attachable.filter((a) => !attachedSet.has(a.ref));
    const filtered = q ? rest.filter((a) => a.name.toLowerCase().includes(q)) : rest;
    return [...pinned, ...filtered];
  }, [attachedEntries, attachable, attachedSet, query]);

  const projectsQuery = useMemo(() => new QueryRequest({ type: Project.type }), []);
  const { data: projects = [] } = useEntitiesQuery<Project>(projectsQuery, { enabled: open });
  const projectLocked = !!activeProcess;

  const toggleRow = useCallback((ref: string) => {
    if (attachedSet.has(ref)) void onDetach(ref);
    else void onAttach(ref);
  }, [attachedSet, onAttach, onDetach]);

  // Reset to list mode every time the popover closes.
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setMode('list');
      setQuery('');
    }
  }, []);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="chat-settings-popover">
        {/* Header */}
        <div className="flex items-center gap-1.5 border-b px-3 py-2">
          {mode === 'add' && (
            <button
              type="button"
              className="-ml-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted"
              onClick={() => setMode('list')}
              title="Back"
              data-testid="chat-settings-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <Settings className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">
            {mode === 'add' ? 'Add asset' : 'Chat settings'}
          </span>
        </div>

        {mode === 'list' ? (
          <>
            {/* ── Assets table ────────────────────────────────────────── */}
            <div data-testid="chat-settings-attached-table">
              {attachedEntries.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  No assets attached.
                </div>
              )}
              {attachedEntries.map((e) => {
                const Icon = e.icon;
                return (
                  <div
                    key={e.ref}
                    className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
                    data-testid={`chat-settings-attached-${e.ref}`}
                  >
                    <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs">{e.name}</span>
                    <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {e.type}
                    </span>
                    <button
                      type="button"
                      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => void onDetach(e.ref)}
                      title="Remove"
                      data-testid={`chat-settings-detach-${e.ref}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="flex w-full items-center gap-2 border-b bg-muted/30 px-3 py-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setMode('add')}
                data-testid="chat-settings-add"
              >
                <Plus className="h-3.5 w-3.5" />
                Add asset
              </button>
            </div>

            {/* ── Project ─────────────────────────────────────────────── */}
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
          </>
        ) : (
          /* ── Add mode: search over agents+skills, attached pinned+checked ── */
          <div>
            <div className="border-b px-3 py-2">
              <input
                autoFocus
                type="text"
                placeholder="Search agents and skills…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                data-testid="chat-settings-add-search"
              />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {addListEntries.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  No matches.
                </div>
              )}
              {addListEntries.map((e) => {
                const Icon = e.icon;
                const checked = attachedSet.has(e.ref);
                return (
                  <label
                    key={e.ref}
                    className="flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0 hover:bg-muted/50"
                    data-testid={`chat-settings-add-row-${e.ref}`}
                  >
                    <input
                      type="checkbox"
                      className="h-3 w-3 flex-shrink-0"
                      checked={checked}
                      onChange={() => toggleRow(e.ref)}
                    />
                    <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {e.type}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
