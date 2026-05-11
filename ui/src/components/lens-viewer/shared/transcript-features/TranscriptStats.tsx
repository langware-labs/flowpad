import { Bot, CheckSquare, Clock, Code, FileText, User, Wrench } from 'lucide-react';
import type { TranscriptHeader } from '@sdk';

import { computeStats } from './transcript-stats';
import { formatDuration, formatNumber } from './transcript-utils';
import type { UnifiedEntry } from './types';

function StatBadge({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-1.5 rounded bg-muted/50 px-2 py-1">
      <Icon className="h-3 w-3 text-muted-foreground" />
      <span className="text-xs font-medium">{typeof value === 'number' ? formatNumber(value) : value}</span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

function FilterBadge({
  icon: Icon,
  label,
  value,
  checked,
  onToggle,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 rounded bg-muted/50 px-2 py-1">
      <input type="checkbox" checked={checked} onChange={onToggle} className="h-3 w-3 accent-primary" />
      <Icon className="h-3 w-3 text-muted-foreground" />
      <span className="text-xs font-medium">{typeof value === 'number' ? formatNumber(value) : value}</span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </label>
  );
}

export function TranscriptStats({
  entries,
  sessionId,
  header,
  showUser,
  showAssistant,
  toolFilters,
  onToggleUser,
  onToggleAssistant,
  onToggleTool,
  onClearFilters,
  onDisableAll,
  onOpenTasks,
}: {
  entries: UnifiedEntry[];
  sessionId: string | null;
  header: TranscriptHeader;
  showUser: boolean;
  showAssistant: boolean;
  toolFilters: Record<string, boolean>;
  onToggleUser: () => void;
  onToggleAssistant: () => void;
  onToggleTool: (toolName: string) => void;
  onClearFilters: () => void;
  onDisableAll: () => void;
  onOpenTasks?: () => void;
}) {
  const stats = computeStats(entries);
  const toolEntries = Object.entries(toolFilters);

  return (
    <div className="border-b border-border bg-card p-3">
      {/* Metadata row */}
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {sessionId && (
          <span className="font-mono" title="Session ID">
            {sessionId.slice(0, 8)}...
          </span>
        )}
        {onOpenTasks && (
          <button
            onClick={onOpenTasks}
            className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary hover:bg-primary/20"
            title="View session tasks"
          >
            <CheckSquare className="h-3 w-3" />
            Tasks
          </button>
        )}
        {header.cli_version && <span>v{header.cli_version}</span>}
        {header.git?.branch && (
          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600">{header.git.branch}</span>
        )}
        {header.cwd && <span className="truncate font-mono">{header.cwd}</span>}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <FilterBadge icon={User} label="User" value={stats.userMessages} checked={showUser} onToggle={onToggleUser} />
        <FilterBadge
          icon={Bot}
          label="Assistant"
          value={stats.assistantMessages}
          checked={showAssistant}
          onToggle={onToggleAssistant}
        />
        <StatBadge icon={Wrench} label="Tool Calls" value={stats.toolCalls} />
        <StatBadge icon={FileText} label="Entries" value={stats.totalEntries} />
        <StatBadge icon={Code} label="Tools" value={stats.uniqueTools} />
        {stats.duration && <StatBadge icon={Clock} label="Duration" value={formatDuration(stats.duration)} />}
      </div>

      {/* Tool call filters */}
      {toolEntries.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Tool calls by type</span>
            <div className="flex items-center gap-2">
              <button
                onClick={onDisableAll}
                className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
              >
                Disable all
              </button>
              <button
                onClick={onClearFilters}
                className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-muted"
              >
                Enable all
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {toolEntries.map(([toolName, enabled]) => (
              <label key={toolName} className="flex items-center gap-1 rounded bg-muted/50 px-2 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => onToggleTool(toolName)}
                  className="h-3 w-3 accent-primary"
                />
                <span className="font-mono">{toolName}</span>
                <span className="text-[10px] text-muted-foreground">{formatNumber(stats.toolCounts[toolName] || 0)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
