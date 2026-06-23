import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { isAllScope, scopeIncludesUser, scopeProjectIds, type ScopeFilter } from '@src/lib/scope-filter';
import { ActionInfo, dataManager, type ITrigger } from '@sdk';
import { HelpCircle, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TriggerListItem } from './TriggerListItem';
import { SCOPE_LABELS } from './scope-colors';

interface Props {
  triggers: ITrigger[];
  selectedTrigger: ITrigger | null;
  onSelect: (trigger: ITrigger) => void;
  onOpenLog: (trigger: ITrigger) => void;
  onNewSchedule: () => void;
  isCreatingSchedule: boolean;
  /** Seeds the ScopeFilterIconBar's Project chip and pre-selects the current
   *  project in the picker. */
  currentProjectId: string | null;
  /** Current project display name — shown in the Project icon's tooltip. */
  currentProjectName?: string | null;
  /** URL-first scope filter (read from the dock options by the host) plus its
   *  writer. The scope lives in the URL — this component is fully controlled. */
  scope: ScopeFilter;
  onScopeChange: (scope: ScopeFilter) => void;
}

const SCOPE_ORDER = ['system', 'user', 'project'] as const;

function groupByScope(triggers: ITrigger[]): Record<string, ITrigger[]> {
  const grouped: Record<string, ITrigger[]> = {};
  for (const trigger of triggers) {
    const scope = trigger.scope || 'user';
    if (!grouped[scope]) grouped[scope] = [];
    grouped[scope].push(trigger);
  }
  return grouped;
}

/**
 * Uniform visibility rule applied to all trigger types. The ScopeFilter
 * controls `user` + `project` visibility (same as every other ScopeFilterBar
 * consumer). System triggers ride on a separate `includeSystem` boolean,
 * because the unified ScopeFilter shape is `{user, projects}` and other
 * consumers depend on that shape — adding system there would force a schema
 * change across FsRecordsScannerViewer / SweepOrphansDialog / browseable-tree.
 */
function filterTriggers(
  triggers: ITrigger[],
  scope: ScopeFilter,
  includeSystem: boolean,
): ITrigger[] {
  return triggers.filter((t) => {
    const s = t.scope || 'user';
    if (s === 'system') return includeSystem;
    // "All" shows everything (user + every project); system still rides the
    // separate `includeSystem` toggle (handled above).
    if (isAllScope(scope)) return true;
    if (s === 'project') {
      // Project-scoped triggers without a project_id are unreachable via the
      // chip picker — hide them rather than leaking into the list.
      const pid = t.project_id ?? '';
      return pid !== '' && scopeProjectIds(scope).includes(pid);
    }
    // Anything else (legacy / unknown / 'user') goes through the user toggle.
    return scopeIncludesUser(scope);
  });
}

export function TriggersList({
  triggers,
  selectedTrigger,
  onSelect,
  onOpenLog,
  onNewSchedule,
  isCreatingSchedule,
  currentProjectId,
  currentProjectName,
  scope,
  onScopeChange,
}: Props) {
  const [includeSystem, setIncludeSystem] = useState(false);

  const visibleTriggers = useMemo(
    () => filterTriggers(triggers, scope, includeSystem),
    [triggers, scope, includeSystem],
  );

  const hookTriggers = visibleTriggers.filter((t) => (t.trigger_type ?? 'hook') === 'hook');
  const scheduleTriggers = visibleTriggers.filter((t) => t.trigger_type === 'schedule');
  const fsopTriggers = visibleTriggers.filter((t) => t.trigger_type === 'fsop');

  const hookGrouped = groupByScope(hookTriggers);
  const scheduleGrouped = groupByScope(scheduleTriggers);
  const fsopGrouped = groupByScope(fsopTriggers);

  const hiddenSystemCount = includeSystem
    ? 0
    : triggers.filter((t) => (t.scope || 'user') === 'system').length;

  return (
    <div>
      {/* Top filter row: canonical icon scope bar (All/User/Project/Selected,
          same as the Assets sidebar) plus a separate "Include system" checkbox.
          Scope is URL-first — `scope`/`onScopeChange` come from the dock URL. */}
      <div className="flex flex-col gap-1.5 border-b px-3 py-2">
        <ScopeFilterIconBar
          scope={scope}
          currentProjectId={currentProjectId}
          currentProjectName={currentProjectName}
          onScopeChange={onScopeChange}
        />
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="triggers-include-system"
            checked={includeSystem}
            onCheckedChange={(v) => setIncludeSystem(v === true)}
            className="h-3 w-3"
          />
          <label
            htmlFor="triggers-include-system"
            className="cursor-pointer select-none text-[10px] text-muted-foreground"
          >
            Include system
            {hiddenSystemCount > 0 && (
              <span className="ml-1 text-muted-foreground/60">({hiddenSystemCount})</span>
            )}
          </label>
        </div>
      </div>

      {/* Schedule Triggers section (always rendered — empty state shows a "Create one" affordance). */}
      <TypeSection
        title="Schedule Triggers"
        grouped={scheduleGrouped}
        count={scheduleTriggers.length}
        trailing={
          <Button
            variant="ghost"
            size="icon"
            className={`h-4 w-4 ${isCreatingSchedule ? 'text-primary' : ''}`}
            onClick={onNewSchedule}
            title="New schedule trigger"
          >
            <Plus className="h-3 w-3" />
          </Button>
        }
        renderItem={(trigger) => (
          <TriggerListItem
            key={trigger.id || trigger.name}
            trigger={trigger}
            isSelected={selectedTrigger?.id === trigger.id}
            onSelect={() => onSelect(trigger)}
            onOpenLog={() => onOpenLog(trigger)}
          />
        )}
        emptyState={
          !isCreatingSchedule && (
            <div className="px-3 py-3 text-[11px] text-muted-foreground">
              No schedule triggers yet.{' '}
              <button className="underline hover:text-foreground" onClick={onNewSchedule}>
                Create one
              </button>
            </div>
          )
        }
      />

      {/* FSOp + Hook sections — always rendered (even when empty) so the
          section types are discoverable; each header carries a `?` popover
          explaining the type-specific creation flow. */}
      <TypeSection
        title="FSOp Triggers"
        grouped={fsopGrouped}
        count={fsopTriggers.length}
        trailing={<FsopHelpPopover />}
        emptyState={
          <div className="px-3 py-3 text-[11px] text-muted-foreground">
            No FSOp triggers visible. Toggle <em>Include system</em> above to see system-installed watchers.
          </div>
        }
        renderItem={(trigger) => (
          <TriggerListItem
            key={trigger.id || trigger.name}
            trigger={trigger}
            isSelected={selectedTrigger?.id === trigger.id}
            onSelect={() => onSelect(trigger)}
            onOpenLog={() => onOpenLog(trigger)}
          />
        )}
      />
      <TypeSection
        title="Hook Triggers"
        grouped={hookGrouped}
        count={hookTriggers.length}
        trailing={<HookHelpPopover />}
        emptyState={
          <div className="px-3 py-3 text-[11px] text-muted-foreground">
            No hook triggers yet. Drop a rule file under{' '}
            <code className="rounded bg-muted px-1">~/.flow/skill_rules/</code> then click the{' '}
            <em>?</em> above to discover.
          </div>
        }
        renderItem={(trigger) => (
          <TriggerListItem
            key={trigger.id || trigger.name}
            trigger={trigger}
            isSelected={selectedTrigger?.id === trigger.id}
            onSelect={() => onSelect(trigger)}
            onOpenLog={() => onOpenLog(trigger)}
          />
        )}
      />
    </div>
  );
}

/** Help popover for the Hook section. Hook triggers come from filesystem
 *  rules; this surface gives the user the path + a Discover button that
 *  calls the existing POST /api/v1/graph/trigger/discover action. */
function HookHelpPopover() {
  const [discovering, setDiscovering] = useState(false);
  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      // The discover action is registered as @core_action.get(action_name="discover")
      // on the Trigger class. Must be GET — POST would 405. Mirror the TS-side
      // `Trigger.discover()` static (ts_sdk/src/entities/trigger.ts) which uses 'GET'.
      const action = new ActionInfo('discover', 'trigger', null, 'GET');
      await dataManager.callAction(action);
    } catch {
      // Swallow — the popover doesn't have a slot for an error toast and
      // refusal here would be confusing. List refreshes on its own.
    } finally {
      setDiscovering(false);
    }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-4 w-4" onClick={(e) => e.stopPropagation()} title="About hook triggers">
          <HelpCircle className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-xs" onClick={(e) => e.stopPropagation()}>
        <p className="mb-2">
          Hook triggers come from rule files at{' '}
          <code className="rounded bg-muted px-1">~/.flow/skill_rules/</code>.
          Drop in a Python rule, then click <em>Discover</em> to load it.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => { e.stopPropagation(); void handleDiscover(); }}
          disabled={discovering}
          className="h-7 w-full text-xs"
        >
          {discovering ? 'Discovering…' : 'Discover rules'}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** Help popover for the FSOp section. Today all FSOp triggers are
 *  system-installed via set_service_triggers(); user-facing creation is
 *  API-only. The popover documents that, leaving room for a future + button. */
function FsopHelpPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-4 w-4" onClick={(e) => e.stopPropagation()} title="About FSOp triggers">
          <HelpCircle className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-xs" onClick={(e) => e.stopPropagation()}>
        <p>
          FSOp triggers watch a file or folder and fire on changes. They run
          a configured action (callback, script, or NotifyEntity) each time.
        </p>
        <p className="mt-2">
          System-installed triggers are seeded at boot via{' '}
          <code className="rounded bg-muted px-1">set_service_triggers()</code>.{' '}
          User-driven creation is API-only for now (UI builder coming soon).
        </p>
      </PopoverContent>
    </Popover>
  );
}

interface TypeSectionProps {
  title: string;
  grouped: Record<string, ITrigger[]>;
  count: number;
  renderItem: (trigger: ITrigger) => React.ReactNode;
  trailing?: React.ReactNode;
  emptyState?: React.ReactNode;
}

/**
 * Section for one trigger type. Renders a sticky header with a count badge
 * and an optional trailing action (e.g. the +Create button on Schedule),
 * then the rows.
 *
 * Per-scope sub-labels are rendered ONLY when more than one scope is present
 * inside this section — keeps the layout flat when (the common case) one
 * scope covers everything.
 */
function TypeSection({ title, grouped, count, renderItem, trailing, emptyState }: TypeSectionProps) {
  const activeScopes = SCOPE_ORDER.filter((s) => (grouped[s]?.length ?? 0) > 0);
  const showSubLabels = activeScopes.length > 1;

  return (
    <div>
      <div className="sticky top-0 flex items-center gap-1 bg-muted/70 px-3 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
          {title}
        </span>
        {count > 0 && (
          <Badge variant="secondary" className="h-4 px-1 text-[9px]">
            {count}
          </Badge>
        )}
        {trailing}
      </div>
      {count === 0 ? (
        emptyState ?? null
      ) : showSubLabels ? (
        activeScopes.map((scope) => (
          <div key={scope}>
            <div className="sticky top-5 bg-muted/50 px-3 py-0.5 text-[10px] font-medium text-muted-foreground/70">
              {SCOPE_LABELS[scope]}
            </div>
            {grouped[scope].map(renderItem)}
          </div>
        ))
      ) : (
        activeScopes.flatMap((scope) => grouped[scope].map(renderItem))
      )}
    </div>
  );
}
