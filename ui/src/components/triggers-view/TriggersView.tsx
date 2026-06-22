import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { type ITrigger } from '@sdk';
import { defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';
import { useTriggers } from '@src/hooks/useTriggers';
import { useProject } from '@src/hooks/useProject';
import { TriggersList } from './TriggersList';
import { TriggerEditor } from './TriggerEditor';
import { ScheduleTriggerEditor } from './ScheduleTriggerEditor';
import { FsopTriggerDetail } from './FsopTriggerDetail';
import { TriggerInvocationsPanel } from './TriggerInvocationsPanel';

export function TriggersView() {
  const { triggers, isLoading: loading } = useTriggers();
  const { project } = useProject();
  // Filtering (by scope + current project + include-system) lives in TriggersList
  // so all trigger types follow the same rule. TriggersView just passes the
  // full set + the current project id down.
  const [selectedTrigger, setSelectedTrigger] = useState<ITrigger | null>(null);
  const [isCreatingSchedule, setIsCreatingSchedule] = useState(false);
  const { navigation, currentDock } = useDockNavigation();

  // Scope filter is URL-first (same as the Assets sidebar): read it from the
  // dock options, fall back to the context-aware default. Writing the URL is the
  // single source of truth — `urlScope` re-derives on the next render. The scope
  // is excluded from the Triggers tabHash, so changing it stays in ONE tab
  // (unlike Assets, where each scope is its own tab).
  const urlScope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? defaultScopeFilter(project?.id ?? null),
    [currentDock, project?.id],
  );
  const handleScopeChange = useCallback((scope: ScopeFilter) => {
    const base = currentDock ?? DockPointer.forTab(ViewType.TRIGGERS);
    navigation.openDock(base.withScopeFilter(scope));
  }, [currentDock, navigation]);

  // Reset selection when the user switches project — the previously-selected
  // trigger may no longer match the new project's scope filter, and keeping
  // it would surface a stale trigger in the center/right panels.
  //
  // Guarded against the `undefined → loaded` transition on first mount: if
  // `useProject()` hasn't resolved yet, project is undefined; once it loads
  // the effect would fire and clobber any selection / in-progress creation
  // the user kicked off in the meantime. We only reset on actual id changes
  // between two non-undefined values.
  const prevProjectIdRef = useRef<string | undefined>(project?.id);
  useEffect(() => {
    const prev = prevProjectIdRef.current;
    const curr = project?.id;
    prevProjectIdRef.current = curr;
    if (prev !== undefined && curr !== undefined && prev !== curr) {
      setSelectedTrigger(null);
      setIsCreatingSchedule(false);
    }
  }, [project?.id]);

  const openLog = useCallback((trigger: ITrigger) => {
    if (trigger.id) {
      navigation.openTab(ViewType.LENS, DockPointer.forLens('trigger', 'log', trigger.id));
    }
  }, [navigation]);

  const handleScheduleSaved = (saved: ITrigger) => {
    setIsCreatingSchedule(false);
    setSelectedTrigger(saved);
  };

  const handleNewSchedule = () => {
    setIsCreatingSchedule(true);
    setSelectedTrigger(null);
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading triggers...</div>;
  }

  // Determine center panel content
  const renderCenter = () => {
    if (isCreatingSchedule) {
      return (
        <ScheduleTriggerEditor
          trigger={null}
          onSaved={handleScheduleSaved}
          onCancel={() => setIsCreatingSchedule(false)}
        />
      );
    }
    if (!selectedTrigger) {
      if (triggers.length === 0) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
            <p className="text-sm">No triggers yet</p>
            <Button variant="outline" size="sm" className="gap-2" onClick={handleNewSchedule}>
              <Plus className="h-4 w-4" />
              New Schedule Trigger
            </Button>
            <p className="max-w-xs text-center text-xs text-muted-foreground/70">
              Hook triggers come from rule files under{' '}
              <code className="rounded bg-muted px-1">~/.flow/skill_rules/</code>.{' '}
              FSOp triggers are installed by the system or via the API.
            </p>
          </div>
        );
      }
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Select a trigger to view
        </div>
      );
    }
    // Dispatch on trigger_type — each source has a fundamentally different
    // authoring artifact (code / form / config). Falling through to the hook
    // code editor for non-hook triggers used to render the callback's source
    // module as if it were the user's trigger.py — the "shows my code" bug.
    switch (selectedTrigger.trigger_type) {
      case 'schedule':
        return (
          <ScheduleTriggerEditor
            trigger={selectedTrigger}
            onSaved={handleScheduleSaved}
            onCancel={() => setSelectedTrigger(null)}
          />
        );
      case 'fsop':
        // `key` forces remount when the selected FSOp trigger changes.
        // Without it, child state (CallbackSourceCollapsible's loaded/content)
        // persists across triggers and shows stale source.
        return <FsopTriggerDetail key={selectedTrigger.id} trigger={selectedTrigger} />;
      case 'hook':
      default:
        return <TriggerEditor trigger={selectedTrigger} />;
    }
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — trigger list */}
      <div className="flex w-[280px] flex-shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium">Triggers</span>
          <Badge variant="secondary" className="text-[10px]">{triggers.length}</Badge>
        </div>
        <div className="flex-1 overflow-auto">
          <TriggersList
            triggers={triggers}
            selectedTrigger={selectedTrigger}
            onSelect={(t) => { setSelectedTrigger(t); setIsCreatingSchedule(false); }}
            onOpenLog={openLog}
            onNewSchedule={handleNewSchedule}
            isCreatingSchedule={isCreatingSchedule}
            currentProjectId={project?.id ?? null}
            currentProjectName={project?.getDisplayName() ?? project?.name ?? null}
            scope={urlScope}
            onScopeChange={handleScopeChange}
          />
        </div>
      </div>

      {/* Center panel — type-specific editor */}
      <div className="flex flex-1 flex-col overflow-hidden border-r">
        {renderCenter()}
      </div>

      {/* Right panel — invocations */}
      <div className="flex w-[300px] flex-shrink-0 flex-col">
        <TriggerInvocationsPanel trigger={isCreatingSchedule ? null : selectedTrigger} />
      </div>
    </div>
  );
}
