/**
 * Terminal provider presentation — the vendor chip glyph/label table and the
 * lazy process tooltip. Lives in its own module (not the controller) because both
 * the strip's row builder (`tab-row-item.tsx`) and the chrome controller consume
 * it; keeping it here avoids a component file exporting non-components (which
 * breaks Vite Fast Refresh) and a circular controller↔row-item import.
 */
import {
  AgenticProcess,
  getDisplayStatus,
  isProcessRunning,
  ProcessStatus,
  TypeId,
} from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';
import { formatTimeAgo, useLastStatusChange } from '@src/store/pending-actions-store';
import { SquareTerminal } from 'lucide-react';
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
