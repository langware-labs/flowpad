/**
 * Terminal provider presentation — the vendor chip glyph/label table and the
 * lazy process tooltip. Lives in its own module (not the controller) because both
 * the strip's row builder (`tab-row-item.tsx`) and the chrome controller consume
 * it; keeping it here avoids a component file exporting non-components (which
 * breaks Vite Fast Refresh) and a circular controller↔row-item import.
 */
import { AgenticProcess, getDisplayStatus, isProcessRunning, ProcessStatus, Tab, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';
import { formatTimeAgo, useLastStatusChange } from '@src/store/pending-actions-store';
import { useEntityLocationLabel } from '@src/components/graph-view/ui/EntityIcon';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockForDisplayTarget, type DisplayTargetLike } from '@src/navigation/display-target-pointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Eye, SquareTerminal } from 'lucide-react';
import React, { useMemo } from 'react';

/** Vendor metadata per terminal provider kind — the single source for the strip
 *  chips' icon resolution and the vendor openers' glyph/color. */
export const PROVIDER_META: Record<
  'claude' | 'codex' | 'copilot' | 'shell',
  { Icon: React.ComponentType<{ className?: string }>; iconClassName: string; label: string }
> = {
  claude: { Icon: ClaudeIcon, iconClassName: 'text-orange-500', label: 'Claude Code tab' },
  codex: { Icon: CodexIcon, iconClassName: 'text-emerald-500', label: 'Codex tab' },
  copilot: { Icon: CopilotIcon, iconClassName: 'text-sky-500', label: 'Copilot tab' },
  shell: { Icon: SquareTerminal, iconClassName: 'text-muted-foreground', label: 'Shell tab' },
};

function timeAgo(date: Date | string | undefined | null): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDateTime(date: Date | string | undefined | null): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline gap-2">
    <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{label}</span>
    <span className="text-[10px] text-foreground">{value}</span>
  </div>
);

const ProcessInfoTooltip: React.FC<{ process: AgenticProcess; statusReason?: string }> = ({
  process,
  statusReason,
}) => {
  const workdir = process.workdir;
  const isAlive = isProcessRunning(process.status ?? ProcessStatus.NEW);
  const status = getDisplayStatus(process) ?? ProcessStatus.NEW;
  const workerSessionId = process.session_id ?? null;
  const lastStatusChangedAt = useLastStatusChange(process.id ?? null);
  const displayName = useMemo(
    () => resolveProcessDisplayName(process),
    [process.context_data, process.name, process.instruction_content],
  );

  return (
    <div className="min-w-[220px] space-y-1.5">
      <p className="text-xs font-semibold text-foreground" data-testid="tab-tooltip-name">
        {displayName}
      </p>
      {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${isAlive ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
        />
        <span className="text-[11px] font-semibold capitalize text-foreground">{status}</span>
        {lastStatusChangedAt !== null && (
          <span className="text-[10px] text-muted-foreground" data-testid="tab-status-ago">
            {formatTimeAgo(lastStatusChangedAt)}
          </span>
        )}
      </div>
      {workdir && (
        <p className="max-w-[240px] truncate font-mono text-[10px] text-muted-foreground" title={workdir}>
          {workdir}
        </p>
      )}
      <div className="space-y-1 border-t pt-1.5">
        <InfoRow label="Created" value={`${formatDateTime(process.created_date)} · ${timeAgo(process.created_date)}`} />
        <InfoRow label="Updated" value={`${formatDateTime(process.updated_date)} · ${timeAgo(process.updated_date)}`} />
        {workerSessionId && <InfoRow label="Session" value={workerSessionId.slice(0, 8) + '…'} />}
      </div>
    </div>
  );
};

/**
 * Tooltip body for a process chip. The strip renders chips from `TabRow` alone, so
 * an off-screen chip has no backing entity. This fetches the process ON DEMAND —
 * Radix mounts `TooltipContent`'s children only when the tooltip opens, so the
 * fetch fires on hover, never at strip build. Until it resolves (or 404s), a lean
 * header from the Tab label is shown.
 */
export const LazyProcessTooltip: React.FC<{
  processId: string;
  fallbackName: string;
  statusReason?: string;
}> = ({ processId, fallbackName, statusReason }) => {
  const { data: process } = useEntity<AgenticProcess>(new TypeId(AgenticProcess.type, processId));
  if (process) return <ProcessInfoTooltip process={process} statusReason={statusReason} />;
  return (
    <div className="min-w-[180px] space-y-1">
      <p className="text-xs font-semibold text-foreground" data-testid="tab-tooltip-name">
        {fallbackName}
      </p>
      {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
    </div>
  );
};

/**
 * The marker a process chip carries when its agent has shown something.
 *
 * Outside vibe a `flow show` mints a tab but never navigates (see
 * `use-show-target-listener`), so the agent's "look at this" needs somewhere to
 * land that does not steal the screen. This is it: a glyph on the process's own
 * chip that opens whatever it last showed. In vibe the Display pane already
 * plays that role — the badge is harmless there, but the pane is the answer.
 *
 * Renders nothing until there is a target that maps to a dock, so a process
 * that has never shown anything looks exactly as it does today.
 */
export const ShownTargetBadge: React.FC<{ processId: string }> = ({ processId }) => {
  const { data: process } = useEntity<AgenticProcess>(new TypeId(AgenticProcess.type, processId));
  const { navigation } = useDockNavigation();
  const shown = (process?.context_data as { last_shown?: DisplayTargetLike } | undefined)?.last_shown;
  const projectId = process?.project_id ?? null;
  // Same project rebase the listener applies when it mints the tab — without it
  // this would navigate to the scope-collapsed Assets dock instead of the
  // document's own tab, i.e. a different tab than the one the show created.
  const dock = useMemo(() => {
    const base = dockForDisplayTarget(shown);
    return base ? DockPointer.rebaseAssetsOntoProject(base, projectId) : null;
  }, [shown, projectId]);
  if (!dock) return null;

  const label = shown?.name || shown?.path?.split('/').pop() || shown?.type || 'the shown item';
  return (
    <button
      type="button"
      // The chip's own click activates the tab; this one opens the target
      // instead, so it must not bubble (same guard the close button uses).
      onClick={(e) => {
        e.stopPropagation();
        navigation.openDock(dock);
      }}
      className="shrink-0 rounded p-0.5 text-sky-500 transition-colors hover:bg-muted hover:text-sky-400"
      title={`Open ${label}`}
      aria-label={`Open ${label}`}
      data-testid="tab-shown-target"
    >
      <Eye className="h-3 w-3" />
    </button>
  );
};

/** "agentic_process" → "Agentic Process", "markdown" → "Markdown". */
// Moved to `@src/utils/humanize` — a pure function does not belong in a React
// module that leaf components need to import. Re-exported so callers here and
// in `tabs/` keep their import path.
export { humanizeType } from '@src/utils/humanize';

/**
 * Info card for a non-terminal (content) tab — same chrome as
 * `ProcessInfoTooltip` so every chip's tooltip reads identically: a header,
 * a kind row, the dock address, then the open/update timestamps. Content tabs
 * have no live process, so the kind dot is a static accent (not a liveness
 * indicator) and the fields come straight off the `Tab` row — no entity fetch.
 */
export const ContentTabTooltip: React.FC<{
  tab: Tab;
  typeLabel: string;
  statusReason?: string;
  location?: boolean;
}> = ({ tab, typeLabel, statusReason, location }) => {
  const dock = tab.dockPointer;
  const address = dock?.pointer || (tab.target_type && tab.target_id ? `${tab.target_type}/${tab.target_id}` : '');
  const lastActive = tab.last_active_at;
  const locationLabel = useEntityLocationLabel(location);

  return (
    <div className="min-w-[220px] space-y-1.5">
      <p className="text-xs font-semibold text-foreground" data-testid="tab-tooltip-name">
        {tab.name || typeLabel}
      </p>
      {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
      {location !== undefined && (
        <p className="text-[11px] text-muted-foreground" data-testid="tab-tooltip-location">
          {locationLabel}
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
        <span className="text-[11px] font-semibold text-foreground">{typeLabel}</span>
        {tab.worktree && <span className="text-[10px] font-medium text-amber-500">worktree</span>}
      </div>
      {address && (
        <p className="max-w-[240px] truncate font-mono text-[10px] text-muted-foreground" title={address}>
          {address}
        </p>
      )}
      <div className="space-y-1 border-t pt-1.5">
        {tab.created_date && (
          <InfoRow label="Opened" value={`${formatDateTime(tab.created_date)} · ${timeAgo(tab.created_date)}`} />
        )}
        {tab.updated_date && (
          <InfoRow label="Updated" value={`${formatDateTime(tab.updated_date)} · ${timeAgo(tab.updated_date)}`} />
        )}
        {lastActive != null && lastActive !== '' && (
          <InfoRow label="Active" value={timeAgo(typeof lastActive === 'number' ? new Date(lastActive) : lastActive)} />
        )}
      </div>
    </div>
  );
};
