import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ChevronDown, ChevronRight, Edit, FileCode, Filter, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useResources, SystemResourceType } from '@src/hooks/use-resources';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { createClaudeHooksService, type HookItem, VFSPath } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { useSnifferContext } from '@src/contexts/SnifferContext';
import { useLingui, Trans } from '@lingui/react/macro';
import { HookEditor } from './HookEditor';

type ScopeFilter = 'all' | 'user' | 'project' | 'managed' | 'plugin';

const SCOPE_OPTIONS: ScopeFilter[] = ['all', 'user', 'project', 'managed', 'plugin'];

const scopeLabel = (scope: ScopeFilter) => {
  if (scope === 'all') return 'All hooks';
  return scope;
};

const formatDate = (value?: string) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

/** Strip env/home prefix from source_file, returning just the relative hook path */
const hookPath = (sourceFile?: string | null): string | null => {
  if (!sourceFile) return null;
  // Strip home directory prefix (e.g. /Users/foo/.claude/settings.json -> .claude/settings.json)
  const homeDir = sourceFile.match(/^(\/(?:Users|home)\/[^/]+\/)/);
  if (homeDir) return sourceFile.slice(homeDir[1].length);
  return sourceFile;
};

/** Extract the script/binary path from a full command, stripping env vars, interpreter, and arguments.
 *  e.g. `FOO="bar" /usr/bin/python /path/to/cli.py run --flag` → `/path/to/cli.py` */
const shortCmdDisplay = (command?: string | null): string | null => {
  if (!command) return null;
  // Strip leading env var assignments (KEY=value or KEY="value")
  const rest = command.replace(/^\s*(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '');
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return command;
  // If first token looks like an interpreter, skip it and return the next token
  if (tokens.length > 1 && /(?:\/bin\/|^(?:python|node|bash|sh|ruby|perl)\d*$)/.test(tokens[0])) {
    return tokens[1];
  }
  return tokens[0];
};

const hookCountKey = (eventType: string, filePath?: string | null): string => `${eventType}:${filePath || ''}`;

type HookGroup = { groupName: string; groupSource: 'plugin' | 'name'; hooks: HookItem[] };
type HookOrGroup = { type: 'single'; hook: HookItem } | { type: 'group'; group: HookGroup };

/** Group hooks by a key function. Keys with 2+ hooks become collapsible groups. */
function groupHooksBy(
  hooks: HookItem[],
  keyFn: (hook: HookItem) => { name: string; source: 'plugin' | 'name' } | null,
): HookOrGroup[] {
  const counts = new Map<string, number>();
  for (const hook of hooks) {
    const g = keyFn(hook);
    if (g) counts.set(g.name, (counts.get(g.name) ?? 0) + 1);
  }
  const result: HookOrGroup[] = [];
  const groupMap = new Map<string, HookItem[]>();
  const inserted = new Map<string, 'plugin' | 'name'>();
  for (const hook of hooks) {
    const g = keyFn(hook);
    if (g && (counts.get(g.name) ?? 0) >= 2) {
      if (!groupMap.has(g.name)) groupMap.set(g.name, []);
      groupMap.get(g.name)!.push(hook);
      if (!inserted.has(g.name)) {
        inserted.set(g.name, g.source);
        result.push({ type: 'group', group: { groupName: g.name, groupSource: g.source, hooks: groupMap.get(g.name)! } });
      }
    } else {
      result.push({ type: 'single', hook });
    }
  }
  return result;
}

interface HooksBrowserProps {
  highlightHookId?: string;
  highlightEventType?: string;
}

export function HooksBrowser({ highlightHookId, highlightEventType }: HooksBrowserProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { computeNode } = useAgentContext();
  const {
    items: hooks,
    isLoading,
    error,
    refresh,
    fetchMore,
    hasMore,
    invalidate,
  } = useResources<HookItem>(SystemResourceType.HOOK, { limit: 200 });
  const { snifferEnabled } = useContext();
  const { events: snifferEvents, isLoading: snifferLoading } = useSnifferContext();
  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [deletedHookIds, setDeletedHookIds] = useState<Set<string>>(new Set());
  const autoLoadAttempts = useRef(0);
  const highlightRef = useRef<HTMLDivElement>(null);
  const hasScrolled = useRef(false);

  // Editor state
  const [isCreating, setIsCreating] = useState(false);
  const [editingHook, setEditingHook] = useState<HookItem | null>(null);
  const [editorHookName, setEditorHookName] = useState('');
  const [editorEventName, setEditorEventName] = useState('');
  const [editorMatcher, setEditorMatcher] = useState('');
  const [editorHookType, setEditorHookType] = useState<'command' | 'prompt'>('command');
  const [editorCommand, setEditorCommand] = useState('');
  const [editorPrompt, setEditorPrompt] = useState('');
  const [editorTimeout, setEditorTimeout] = useState('60');
  const [editorScope, setEditorScope] = useState<'user' | 'project'>('user');

  useEffect(() => {
    if (!isLoading && hasMore && autoLoadAttempts.current < 25) {
      autoLoadAttempts.current += 1;
      void fetchMore();
    }
  }, [fetchMore, hasMore, isLoading]);

  // Refresh hooks list when sniffer is toggled on/off (skip the initial async load)
  const prevSnifferEnabled = useRef<boolean | null>(null);
  useEffect(() => {
    if (snifferLoading) return; // Wait for initial status fetch
    if (prevSnifferEnabled.current === null) {
      // First real value after async load — capture baseline, don't refresh
      prevSnifferEnabled.current = snifferEnabled;
      return;
    }
    if (prevSnifferEnabled.current !== snifferEnabled) {
      prevSnifferEnabled.current = snifferEnabled;
      // Small delay to let settings.json be written
      const timer = setTimeout(() => {
        invalidate();
        autoLoadAttempts.current = 0;
        void refresh();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [snifferEnabled, snifferLoading, invalidate, refresh]);

  // Scroll to highlighted hook after hooks load
  useEffect(() => {
    if (!highlightHookId || hasScrolled.current || isLoading || hooks.length === 0) return;

    // If the hook is filtered out by scope, clear the scope filter to make it visible
    const matchedHook = hooks.find(
      (h) =>
        h.id.includes(highlightHookId) || h.command?.includes(highlightHookId) || h.event_type === highlightEventType,
    );
    if (matchedHook && scopeFilter !== 'all' && matchedHook.scope !== scopeFilter) {
      setScopeFilter('all');
    }

    // Use a small delay to ensure DOM is rendered
    const timer = setTimeout(() => {
      if (highlightRef.current) {
        highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        hasScrolled.current = true;
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [highlightHookId, highlightEventType, hooks, isLoading, scopeFilter]);

  const filteredHooks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return hooks.filter((hook) => {
      // Filter out optimistically deleted hooks
      if (deletedHookIds.has(hook.id)) {
        return false;
      }

      if (scopeFilter !== 'all' && hook.scope !== scopeFilter) {
        return false;
      }

      if (!normalizedQuery) return true;

      const haystack = [
        hook.name,
        hook.id,
        hook.event_type,
        hook.hook_type,
        hook.matcher,
        hook.command,
        hook.scope,
        hook.source_file,
        hook.path,
        hook.created_at,
        hook.modified_at,
        hook.plugin_name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [hooks, query, scopeFilter, deletedHookIds]);

  const hookEventCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const evt of snifferEvents) {
      if (evt.webhook_type !== 'agent_hook') continue;
      const key = hookCountKey(evt.event_type, evt.hook_file_path);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [snifferEvents]);

  // Snapshot event counts once when hooks finish loading so the initial sort
  // order is stable (most-called first, then most-recently-modified).
  const [sortSnapshot, setSortSnapshot] = useState<Map<string, number> | null>(null);
  const hasCapturedSort = useRef(false);

  useEffect(() => {
    if (!hasCapturedSort.current && !isLoading && hooks.length > 0) {
      hasCapturedSort.current = true;
      setSortSnapshot(new Map(hookEventCounts));
    }
  }, [isLoading, hooks.length, hookEventCounts]);

  // Apply snapshot-based sort to filteredHooks
  const sortedHooks = useMemo(() => {
    if (!sortSnapshot) return filteredHooks;
    return [...filteredHooks].sort((a, b) => {
      const countA = sortSnapshot.get(hookCountKey(a.event_type, a.source_file)) ?? 0;
      const countB = sortSnapshot.get(hookCountKey(b.event_type, b.source_file)) ?? 0;
      if (countB !== countA) return countB - countA;
      const modA = a.modified_at ? new Date(a.modified_at).getTime() : 0;
      const modB = b.modified_at ? new Date(b.modified_at).getTime() : 0;
      return modB - modA;
    });
  }, [filteredHooks, sortSnapshot]);

  const clearFilters = () => {
    setQuery('');
    setScopeFilter('all');
  };

  const handleDeleteHook = useCallback(
    (hook: HookItem) => {
      if (!computeNode) {
        notify.error({
          title: t`Cannot delete hook`,
          message: t`No compute node available`,
        });
        return;
      }

      const hooksService = createClaudeHooksService(computeNode);

      if (!hooksService.canDeleteHook(hook)) {
        notify.error({
          title: t`Cannot delete hook`,
          message: t`No source file available for this hook`,
        });
        return;
      }

      // Optimistically remove from UI immediately
      setDeletedHookIds((prev) => new Set(prev).add(hook.id));

      // Delete in background, only notify on failure
      hooksService
        .deleteHook(hook)
        .then((result) => {
          if (!result.success) {
            // Restore hook on failure
            setDeletedHookIds((prev) => {
              const next = new Set(prev);
              next.delete(hook.id);
              return next;
            });
            notify.error({
              title: t`Failed to delete hook`,
              message: result.error,
            });
          }
        })
        .catch((err) => {
          // Restore hook on error
          setDeletedHookIds((prev) => {
            const next = new Set(prev);
            next.delete(hook.id);
            return next;
          });
          const message = err instanceof Error ? err.message : t`Failed to delete hook`;
          notify.error({
            title: t`Failed to delete hook`,
            message,
          });
        });
    },
    [computeNode],
  );

  // --- Create / Edit handlers ---

  const resetEditor = useCallback(() => {
    setIsCreating(false);
    setEditingHook(null);
    setEditorHookName('');
    setEditorEventName('');
    setEditorMatcher('');
    setEditorHookType('command');
    setEditorCommand('');
    setEditorPrompt('');
    setEditorTimeout('60');
    setEditorScope('user');
  }, []);

  const handleStartCreate = useCallback(() => {
    resetEditor();
    setIsCreating(true);
  }, [resetEditor]);

  const handleStartEdit = useCallback((hook: HookItem) => {
    setIsCreating(false);
    setEditingHook(hook);
    // Pre-fill hookName from flow_metadata_name, or generate from event+matcher
    setEditorHookName(hook.flow_metadata_name || `${hook.event_type}-${hook.matcher || 'all'}`.toLowerCase());
    setEditorEventName(hook.event_type);
    setEditorMatcher(hook.matcher || '');
    setEditorHookType((hook.hook_type as 'command' | 'prompt') || 'command');
    setEditorCommand(hook.command || '');
    setEditorPrompt('');
    setEditorTimeout('60');
    setEditorScope(hook.scope === 'project' ? 'project' : 'user');
  }, []);

  const handleEditorSave = useCallback(async () => {
    if (!computeNode) {
      notify.error({ title: t`No compute node available` });
      return;
    }

    const hooksService = createClaudeHooksService(computeNode);
    const command = editorHookType === 'command' ? editorCommand : editorPrompt;

    // Determine source file from existing hooks of the same scope, or from the editing hook
    let sourceFile: string | undefined;
    if (editingHook?.source_file) {
      sourceFile = editingHook.source_file;
    } else {
      // Find a source_file from existing hooks with matching scope
      const scopeHook = hooks.find((h) => h.scope === editorScope && h.source_file);
      sourceFile = scopeHook?.source_file ?? undefined;
    }

    if (!sourceFile) {
      notify.error({
        title: t`Cannot determine settings file`,
        message: `No existing hooks found for scope "${editorScope}" to determine the settings file path.`,
      });
      return;
    }

    try {
      // Build flow_metadata for this hook
      const flowMetadata = { name: editorHookName.trim() };

      if (editingHook) {
        // Update: delete old, create new
        const result = await hooksService.updateHook(
          sourceFile,
          { eventType: editingHook.event_type, matcher: editingHook.matcher, command: editingHook.command },
          editorEventName,
          editorMatcher || '*',
          { type: editorHookType, command },
          flowMetadata,
        );
        if (!result.success) {
          notify.error({ title: t`Failed to update hook`, message: result.error });
          return;
        }
      } else {
        // Create new
        const result = await hooksService.createHook(
          sourceFile,
          editorEventName,
          editorMatcher || '*',
          { type: editorHookType, command },
          flowMetadata,
        );
        if (!result.success) {
          notify.error({ title: t`Failed to create hook`, message: result.error });
          return;
        }
      }

      resetEditor();
      invalidate();
      autoLoadAttempts.current = 0;
      void refresh();
      notify.success({ title: editingHook ? t`Hook updated` : t`Hook created` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      notify.error({ title: t`Operation failed`, message });
    }
  }, [
    computeNode,
    editorCommand,
    editorEventName,
    editorHookName,
    editorHookType,
    editorMatcher,
    editorPrompt,
    editorScope,
    editingHook,
    hooks,
    invalidate,
    refresh,
    resetEditor,
  ]);

  // Check if a hook row matches the highlight criteria
  const isHighlighted = useCallback(
    (hook: HookItem) => {
      if (!highlightHookId && !highlightEventType) return false;
      const idMatch = highlightHookId && (hook.id.includes(highlightHookId) || hook.command?.includes(highlightHookId));
      const eventMatch = highlightEventType && hook.event_type === highlightEventType;
      // When both hookId and eventType are provided, require both to match
      if (highlightHookId && highlightEventType) return !!(idMatch && eventMatch);
      if (highlightHookId) return !!idMatch;
      return !!eventMatch;
    },
    [highlightHookId, highlightEventType],
  );

  // Group hooks by plugin_name (preferred) or flow_metadata_name when 2+ hooks share a key
  const groupedHooks = useMemo((): HookOrGroup[] => {
    return groupHooksBy(sortedHooks, (hook) => {
      if (hook.plugin_name) return { name: hook.plugin_name, source: 'plugin' };
      if (hook.flow_metadata_name) return { name: hook.flow_metadata_name, source: 'name' };
      return null;
    });
  }, [sortedHooks]);

  // Track which hook is expanded (only one at a time)
  const [expandedHookId, setExpandedHookId] = useState<string | null>(null);

  // Track which groups are expanded (all collapsed by default)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Auto-expand the highlighted hook and its parent group from navigation
  useEffect(() => {
    if (!highlightHookId && !highlightEventType) return;
    const match = sortedHooks.find((h) => isHighlighted(h));
    if (match) {
      setExpandedHookId(match.id);
      // Also expand the parent group if the highlighted hook is inside one
      const parentGroup = groupedHooks.find(
        (item) => item.type === 'group' && item.group.hooks.some((h) => h.id === match.id),
      );
      if (parentGroup?.type === 'group') {
        setExpandedGroups((prev) => new Set(prev).add(parentGroup.group.groupName));
      }
    }
  }, [highlightHookId, highlightEventType, sortedHooks, isHighlighted, groupedHooks]);

  // Create service instance to check if hooks can be deleted/edited
  const hooksService = computeNode ? createClaudeHooksService(computeNode) : null;
  const isEditorOpen = isCreating || editingHook !== null;

  const renderHookRow = (hook: HookItem) => {
    const eventCount = hookEventCounts.get(hookCountKey(hook.event_type, hook.source_file)) ?? 0;
    const isSnifferHook = hook.flow_metadata_name === 'flowpad_sniffer';
    const canDelete = isSnifferHook ? false : (hooksService?.canDeleteHook(hook) ?? false);
    const canEdit = isSnifferHook ? false : canDelete;
    const deleteTooltip = isSnifferHook
      ? t`Managed by FlowPad sniffer`
      : canDelete
        ? t`Delete hook`
        : hook.scope === 'plugin'
          ? `Managed by plugin: ${hook.plugin_name || 'unknown'}`
          : t`Cannot delete: no source file`;
    const highlighted = isHighlighted(hook);
    const isExpanded = expandedHookId === hook.id;

    return (
      <div
        key={hook.id}
        ref={highlighted ? highlightRef : undefined}
        className={cn(highlighted && 'bg-primary/5 ring-2 ring-inset ring-primary')}
      >
        {/* Compact row */}
        <div
          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-muted/50"
          onClick={() => setExpandedHookId(isExpanded ? null : hook.id)}
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {hook.plugin_name && (
            <Badge variant="outline" className="shrink-0 border-blue-300 px-1 py-0 text-[10px] text-blue-600">
              {hook.plugin_name}
            </Badge>
          )}
          <Badge variant="secondary" className="shrink-0 text-[11px]">
            {hook.event_type}
          </Badge>
          {eventCount > 0 && (
            <Badge
              variant="default"
              className="min-w-[1.125rem] justify-center rounded-full px-1 py-0 text-[10px] leading-tight"
            >
              {eventCount}
            </Badge>
          )}
          <Badge variant="outline" className="shrink-0 text-[11px]">
            {hook.scope}
          </Badge>
          <span className="truncate font-mono text-xs text-muted-foreground" title={hook.command || undefined}>
            {shortCmdDisplay(hook.command) || hook.command}
          </span>
          {hookPath(hook.source_file) && (
            <span
              className="truncate text-[11px] italic text-muted-foreground/70"
              title={hook.source_file || undefined}
            >
              {hookPath(hook.source_file)}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {hook.source_file && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  const typeId = computeNode?.typeId;
                  const filePath = typeId
                    ? VFSPath.fromMachinePath(hook.source_file!, typeId).absVfsPath
                    : hook.source_file!;
                  navigation.openDock(DockPointer.forFile(filePath));
                }}
                title={`Open ${hookPath(hook.source_file)} in editor`}
              >
                <FileCode className="h-3 w-3" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              disabled={!canEdit || isEditorOpen}
              onClick={(e) => {
                e.stopPropagation();
                handleStartEdit(hook);
              }}
              title={canEdit ? t`Edit hook` : t`Cannot edit`}
            >
              <Edit className="h-3 w-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
              disabled={!canDelete}
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteHook(hook);
              }}
              title={deleteTooltip}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Expanded detail panel */}
        {isExpanded && (
          <div className="space-y-1.5 border-t bg-muted/20 px-8 py-3 text-xs">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <span className="font-semibold text-muted-foreground"><Trans>Name</Trans></span>
              <span>{hook.name}</span>
              <span className="font-semibold text-muted-foreground"><Trans>Hook Type</Trans></span>
              <span>{hook.hook_type}</span>
              <span className="font-semibold text-muted-foreground"><Trans>Matcher</Trans></span>
              <span className="font-mono">{hook.matcher || '*'}</span>
              <span className="font-semibold text-muted-foreground"><Trans>Command</Trans></span>
              <span className="break-all font-mono">{hook.command}</span>
              {hook.source_file && (
                <>
                  <span className="font-semibold text-muted-foreground"><Trans>Source File</Trans></span>
                  <span className="break-all">{hook.source_file}</span>
                </>
              )}
              {hook.path && (
                <>
                  <span className="font-semibold text-muted-foreground"><Trans>Path</Trans></span>
                  <span className="break-all">{hook.path}</span>
                </>
              )}
              <span className="font-semibold text-muted-foreground"><Trans>ID</Trans></span>
              <span className="font-mono">{hook.id}</span>
              {eventCount > 0 && (
                <>
                  <span className="font-semibold text-muted-foreground"><Trans>Calls</Trans></span>
                  <span>{eventCount}</span>
                </>
              )}
              <span className="font-semibold text-muted-foreground"><Trans>Modified</Trans></span>
              <span>{formatDate(hook.modified_at)}</span>
              <span className="font-semibold text-muted-foreground"><Trans>Created</Trans></span>
              <span>{formatDate(hook.created_at)}</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Editor panel */}
      {isEditorOpen && (
        <div className="mb-4">
          {/* Scope selector for create mode */}
          {isCreating && (
            <div className="mb-3 flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Scope:</span>
              <div className="flex rounded-md border">
                {(['user', 'project'] as const).map((scope, i) => (
                  <Button
                    key={scope}
                    type="button"
                    size="sm"
                    variant={editorScope === scope ? 'secondary' : 'ghost'}
                    className={cn(i === 0 ? 'rounded-l-md rounded-r-none' : 'rounded-l-none rounded-r-md')}
                    onClick={() => setEditorScope(scope)}
                  >
                    {scope}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <HookEditor
            isEditing={editingHook !== null}
            hookName={editorHookName}
            eventName={editorEventName}
            matcher={editorMatcher}
            hookType={editorHookType}
            command={editorCommand}
            prompt={editorPrompt}
            timeout={editorTimeout}
            onHookNameChange={setEditorHookName}
            onEventNameChange={setEditorEventName}
            onMatcherChange={setEditorMatcher}
            onHookTypeChange={setEditorHookType}
            onCommandChange={setEditorCommand}
            onPromptChange={setEditorPrompt}
            onTimeoutChange={setEditorTimeout}
            onSave={() => void handleEditorSave()}
            onCancel={resetEditor}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Search by event, command, matcher, path, scope, or plugin`}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Filter className="h-3.5 w-3.5" />
            <Trans>Filters</Trans>
          </span>
          <div className="flex flex-wrap rounded-md border">
            {SCOPE_OPTIONS.map((scope, index) => {
              const isActive = scopeFilter === scope;
              const roundedClass =
                index === 0 ? 'rounded-l-md' : index === SCOPE_OPTIONS.length - 1 ? 'rounded-r-md' : 'rounded-none';
              return (
                <Button
                  key={scope}
                  type="button"
                  size="sm"
                  variant={isActive ? 'secondary' : 'ghost'}
                  className={`${roundedClass} border-r last:border-r-0`}
                  onClick={() => setScopeFilter(scope)}
                >
                  {scopeLabel(scope)}
                </Button>
              );
            })}
          </div>

          <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 h-3.5 w-3.5" />
            <Trans>Clear filters</Trans>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              invalidate();
              autoLoadAttempts.current = 0;
              void refresh();
            }}
          >
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <Trans>Refresh</Trans>
          </Button>
          <Button type="button" variant="default" size="sm" onClick={handleStartCreate} disabled={isEditorOpen}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            <Trans>Add Hook</Trans>
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Showing {sortedHooks.length} of {hooks.length} hooks
        </span>
        {error && <span className="text-destructive">{error}</span>}
      </div>

      <div className="divide-y rounded-lg border">
        {isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground"><Trans>Scanning hooks...</Trans></div>
        ) : sortedHooks.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground"><Trans>No hooks match your filters</Trans></div>
        ) : (
          groupedHooks.map((item) => {
            if (item.type === 'group') {
              const { groupName, groupSource, hooks: groupHooks } = item.group;
              const isGroupExpanded = expandedGroups.has(groupName);
              const isSnifferGroup = groupName === 'flowpad_sniffer';
              const isPluginGroup = groupSource === 'plugin';
              const groupTotalCount = groupHooks.reduce(
                (sum, h) => sum + (hookEventCounts.get(hookCountKey(h.event_type, h.source_file)) ?? 0),
                0,
              );
              return (
                <div key={`group-${groupName}`}>
                  {/* Group header */}
                  <div
                    className="flex cursor-pointer items-center gap-2 bg-muted/40 px-3 py-1.5 hover:bg-muted/60"
                    onClick={() =>
                      setExpandedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(groupName)) next.delete(groupName);
                        else next.add(groupName);
                        return next;
                      })
                    }
                  >
                    {isGroupExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="text-xs font-semibold">{groupName}</span>
                    <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                      {groupHooks.length}
                    </Badge>
                    {isSnifferGroup && (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-amber-300 px-1 py-0 text-[10px] text-amber-600"
                      >
                        <Trans>managed</Trans>
                      </Badge>
                    )}
                    {isPluginGroup && (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-blue-300 px-1 py-0 text-[10px] text-blue-600"
                      >
                        <Trans>plugin</Trans>
                      </Badge>
                    )}
                    {groupTotalCount > 0 && (
                      <Badge
                        variant="default"
                        className="ml-0.5 min-w-[1.125rem] justify-center rounded-full px-1 py-0 text-[10px] leading-tight"
                      >
                        {groupTotalCount}
                      </Badge>
                    )}
                  </div>
                  {/* Group children */}
                  {isGroupExpanded && (
                    <div className="ml-3 border-l-2 border-muted-foreground/20">
                      {groupHooks.map((hook) => renderHookRow(hook))}
                    </div>
                  )}
                </div>
              );
            }
            return renderHookRow(item.hook);
          })
        )}
      </div>
    </div>
  );
}
