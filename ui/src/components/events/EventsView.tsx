/**
 * Events — rules and the events they fire on, merged.
 *
 * Replaces the old Triggers and Signals screens, which were the two halves of
 * one causal chain shown on two different rail items at two different view-mode
 * depths, sharing zero rows of data. They shared nothing because nothing emitted
 * on a fire; the backend half of this change (`builtin/trigger_on_tag.py`) is
 * what makes the merge mean something rather than just put two panes side by
 * side.
 *
 * Layout: rules rail (Zone B, `TriggersNavigator`) | activity feed | rule editor.
 * The editor pane takes the slot the old fixed 300px invocations panel had —
 * "the feed filtered to one rule" IS the invocations panel, so keeping both
 * would have been two histories of one fact on one screen.
 *
 * Scope: ONE `ScopeFilter` drives both halves — the rules the navigator lists
 * and the events the feed shows. Data sources are deliberately NOT here; they
 * have their own rail screen now.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import apiClient from '@sdk/client';
import { useOnTag } from '@sdk/react/hooks';
import type { FlowEvent } from '@sdk/tags/EventBus';
import { Button } from '@src/components/ui/button';
import { Plus } from 'lucide-react';
import { type ITrigger } from '@sdk';
import { defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useProject } from '@src/hooks/useProject';
import { useTriggers } from '@src/hooks/useTriggers';
import { useTriggerLog } from '@src/hooks/useTriggerLog';
import { ScheduleTriggerEditor } from '@src/components/triggers-view/ScheduleTriggerEditor';
import { FsopTriggerDetail } from '@src/components/triggers-view/FsopTriggerDetail';
import { TriggerEditor } from '@src/components/triggers-view/TriggerEditor';
import { EventFeed } from './EventFeed';
import { InjectorPanel } from './InjectorPanel';
import { buildFeed, eventInScope, ruleInScope } from './feed-model';

/** Fallback ring size until the server reports its own RECENT_EVENTS_CAP, so
 *  the seed and live traffic behave the same either side of a reload. There is
 *  no virtualization library in this repo — cap the list, don't add one. */
const DEFAULT_FEED_CAP = 200;

/** Rows of rule history to request. Independent of the bus ring's capacity —
 *  they are different stores answering different questions. */
const FIRES_PAGE = 200;

interface RecentEventsResponse {
  events: FlowEvent[];
  count: number;
  cap: number;
  patterns: string[];
}

export function EventsView() {
  const { triggers, isLoading } = useTriggers();
  const { project } = useProject();
  const { navigation, currentDock } = useDockNavigation();

  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [cap, setCap] = useState(DEFAULT_FEED_CAP);
  const [paused, setPaused] = useState(false);

  const urlScope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? defaultScopeFilter(project?.id ?? null),
    [currentDock, project?.id],
  );

  const selectedRule = useMemo<ITrigger | null>(() => {
    const id = currentDock?.options?.trigger;
    return id ? triggers.find((t) => t.id === id) ?? null : null;
  }, [currentDock, triggers]);
  const isCreatingSchedule = currentDock?.options?.creating === 'schedule';
  // Shared with the rules navigator through the URL — see DockPointer.forEvents.
  const includeSystem = currentDock?.options?.system === '1';

  // Everything, across rules; `paused` stops the poll as well as the live
  // feed, so a paused screen is genuinely idle.
  const { entries: fires } = useTriggerLog(null, { limit: FIRES_PAGE, enabled: !paused });

  // Seed from the server ring: the bus persists nothing, so without this the
  // feed sits blank until the next event happens to fire.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await apiClient.get('/debug/recent_events')) as RecentEventsResponse | null;
        if (!alive || !data) return;
        setCap(data.cap || DEFAULT_FEED_CAP);
        setEvents((data.events ?? []).slice(-(data.cap || DEFAULT_FEED_CAP)));
      } catch {
        // The feed still works live — a missing seed is not worth shouting about.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useOnTag('*', (event) => {
    if (paused) return;
    setEvents((prev) => [...prev, event].slice(-cap));
  });

  const rulesByName = useMemo(
    () => new Map(triggers.map((t) => [t.name, t])),
    [triggers],
  );

  // Split from the events memo on purpose: `events` changes on EVERY arriving
  // envelope, and re-filtering the whole fire page on each one was pure waste.
  const scopedFires = useMemo(() => {
    if (selectedRule) return fires.filter((f) => f.rule_name === selectedRule.name);
    // A fire's visibility follows its RULE's, through the same predicate the
    // navigator lists by. A fire whose rule has since been deleted still
    // happened — keep it rather than losing history to a tidy-up.
    return fires.filter((f) => {
      const rule = rulesByName.get(f.rule_name);
      return rule ? ruleInScope(rule, urlScope, includeSystem) : true;
    });
  }, [fires, rulesByName, urlScope, includeSystem, selectedRule]);

  const scopedEvents = useMemo(
    () => events.filter((e) => eventInScope(e, urlScope, project?.id ?? null)),
    [events, urlScope, project?.id],
  );

  const rows = useMemo(
    () => buildFeed(scopedEvents, scopedFires),
    [scopedEvents, scopedFires],
  );

  const clearSelection = useCallback(() => {
    navigation.openDock(DockPointer.forEvents(undefined, { system: includeSystem }).withScopeFilter(urlScope));
  }, [navigation, urlScope, includeSystem]);

  const startNewSchedule = useCallback(() => {
    navigation.openDock(
      DockPointer.forEvents(undefined, { creating: 'schedule', system: includeSystem }).withScopeFilter(urlScope),
    );
  }, [navigation, urlScope, includeSystem]);

  const handleScheduleSaved = useCallback(
    (saved: ITrigger) => {
      if (saved.id)
        navigation.openDock(
          DockPointer.forEvents(saved.id, { system: includeSystem }).withScopeFilter(urlScope),
        );
      else clearSelection();
    },
    [navigation, urlScope, clearSelection, includeSystem],
  );

  const renderSidePane = () => {
    if (isCreatingSchedule) {
      return (
        <ScheduleTriggerEditor trigger={null} onSaved={handleScheduleSaved} onCancel={clearSelection} />
      );
    }
    if (!selectedRule) {
      return (
        <div className="flex h-full flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-muted-foreground">
            <p className="text-center text-xs">
              <Trans>Select a rule to edit it, or watch everything here.</Trans>
            </p>
            {triggers.length === 0 && (
              <Button variant="outline" size="sm" className="gap-2" onClick={startNewSchedule}>
                <Plus className="h-4 w-4" />
                <Trans>New schedule rule</Trans>
              </Button>
            )}
          </div>
          <InjectorPanel />
        </div>
      );
    }
    switch (selectedRule.trigger_type) {
      case 'schedule':
        return (
          <ScheduleTriggerEditor
            trigger={selectedRule}
            onSaved={handleScheduleSaved}
            onCancel={clearSelection}
          />
        );
      case 'fsop':
        return <FsopTriggerDetail key={selectedRule.id} trigger={selectedRule} />;
      case 'hook':
      default:
        return <TriggerEditor trigger={selectedRule} />;
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading rules…</Trans>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r">
        <EventFeed
          rows={rows}
          cap={cap}
          totalEvents={events.length}
          paused={paused}
          ruleFilterName={selectedRule?.name ?? null}
          onTogglePause={() => setPaused((p) => !p)}
          onClear={() => setEvents([])}
        />
      </div>
      <div className="flex w-[360px] flex-shrink-0 flex-col overflow-y-auto">{renderSidePane()}</div>
    </div>
  );
}

export default EventsView;
