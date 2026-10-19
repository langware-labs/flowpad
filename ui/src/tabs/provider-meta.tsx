import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import { CopyButton } from '@src/components/ui/copy-button';
/**
 * Terminal provider presentation — the vendor chip glyph/label table and the
 * lazy process tooltip. Lives in its own module (not the controller) because both
 * the strip's row builder (`tab-row-item.tsx`) and the chrome controller consume
 * it; keeping it here avoids a component file exporting non-components (which
 * breaks Vite Fast Refresh) and a circular controller↔row-item import.
 */
import { AgenticProcess, getDisplayStatus, isProcessRunning, ProcessStatus, Tab, TypeId } from '@sdk';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';
import { useEntity } from '@src/hooks/entity-hooks';
import { flowIconComponent } from '@sdk/react/FlowIcon';
import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';
import { formatTimeAgo, useLastStatusChange } from '@src/store/pending-actions-store';
import { useEntityLocationLabel } from '@src/components/graph-view/ui/EntityIcon';
import { TabTooltipName, useInTabTip } from '@src/components/tabs/TabTooltipName';
import { AgentCardBody } from '@src/components/agents/AgentIntroCard';
import { useLaunchingAgent } from '@src/hooks/use-launching-agent';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';

import React, { useMemo } from 'react';

/**
 * Vendor presentation per terminal provider kind — the strip chips' and vendor
 * openers' glyph, tint and label.
 *
 * The glyph is RESOLVED, not imported: `flowIconComponent` returns the icon the
 * packs define for that tag, so this table no longer holds artwork and adding a
 * fifth vendor is a pack entry rather than a component import.
 *
 * The tint stays here on purpose. It is a property of THIS surface, not of the
 * glyph: the same Claude mark is clay on the connections screen and orange in
 * the strip, which is exactly why `provider-marks.tsx` argues a shared glyph
 * must not bake a colour in.
 */
export const PROVIDER_META: Record<
  'claude' | 'codex' | 'copilot' | 'opencode' | 'shell',
  { Icon: React.ComponentType<{ className?: string }>; iconClassName: string; label: MessageDescriptor }
> = {
  claude: { Icon: flowIconComponent('brands.claude'), iconClassName: 'text-orange-500', label: msg`Claude Code tab` },
  codex: { Icon: flowIconComponent('brands.codex'), iconClassName: 'text-emerald-500', label: msg`Codex tab` },
  copilot: { Icon: flowIconComponent('brands.copilot'), iconClassName: 'text-sky-500', label: msg`Copilot tab` },
  opencode: { Icon: flowIconComponent('brands.opencode'), iconClassName: 'text-violet-500', label: msg`OpenCode tab` },
  shell: { Icon: flowIconComponent('flowpad.shell'), iconClassName: 'text-muted-foreground', label: msg`Shell tab` },
};

/** Resolve a vendor's presentation, falling back to Claude for an unknown one.
 *
 *  The table is keyed on the tab-provider spelling; callers hold a `WorkerType`
 *  (`claude_code`) or a raw string off the wire. This owns BOTH the alias and
 *  the fallback policy so consumers don't each carry a cast plus a `??`. */
export function providerKeyFor(workerType: string | undefined | null): keyof typeof PROVIDER_META {
  return knownProviderKey(workerType) ?? 'claude';
}

/** The vendor's key when this table has a mark for it, else `undefined` — for a
 *  surface where drawing Claude's mark on someone else's row would be a lie. */
export function knownProviderKey(workerType: string | undefined | null): keyof typeof PROVIDER_META | undefined {
  const key = workerType === 'claude_code' ? 'claude' : workerType;
  return key && Object.hasOwn(PROVIDER_META, key) ? (key as keyof typeof PROVIDER_META) : undefined;
}

export function providerMetaFor(workerType: string | undefined | null) {
  return PROVIDER_META[providerKeyFor(workerType)];
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

/** A path on one line — clipped, always left-to-right (a session's directory, a document's file). */
export const WorkdirLine: React.FC<{ workdir: string; className?: string }> = ({ workdir, className }) => {
  const { t } = useLingui();
  return (
    <div className={`flex items-center gap-1 ${className ?? ''}`}>
      <p
        className="min-w-0 truncate font-mono text-[10px] text-muted-foreground"
        dir="ltr"
        title={workdir}
        data-testid="tab-workdir"
      >
        {workdir}
      </p>
      <CopyButton
        value={workdir}
        title={t`Copy path: ${workdir}`}
        testId="tab-workdir-copy"
        stopPropagation
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        copiedIconClassName="text-emerald-500"
      />
    </div>
  );
};

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
      <TabTooltipName name={displayName} />
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
      {workdir && <WorkdirLine workdir={workdir} className="max-w-[240px]" />}
      <div className="space-y-1 border-t pt-1.5">
        <InfoRow
          label="Created"
          value={`${formatDateTime(process.created_date)} · ${formatTimeAgoShort(process.created_date)}`}
        />
        <InfoRow
          label="Updated"
          value={`${formatDateTime(process.updated_date)} · ${formatTimeAgoShort(process.updated_date)}`}
        />
        {workerSessionId && <InfoRow label="Session" value={workerSessionId.slice(0, 8) + '…'} />}
      </div>
    </div>
  );
};

/**
 * Hover card for a session chip, in every view mode. A session launched as an
 * agent shows that agent's full card (who it is, what it runs on, where it
 * lives, a way to open it) above where the session is working; any other
 * session keeps what it showed before — the process details in advanced mode,
 * the bare name otherwise. The strip renders chips from `TabRow` alone, so this
 * fetches the process ON DEMAND: Radix mounts `TooltipContent`'s children only
 * when the tooltip opens, so the fetch fires on hover, never at strip build.
 */
export const ProcessTabCard: React.FC<{
  processId: string;
  fallbackName: string;
  statusReason?: string;
}> = ({ processId, fallbackName, statusReason }) => {
  const isAdvanced = useIsAdvanced();
  const inTabTip = useInTabTip();
  const { data: process } = useEntity<AgenticProcess>(new TypeId(AgenticProcess.type, processId));
  const agent = useLaunchingAgent(process?.deployment_id);
  const details = process && isAdvanced ? <ProcessInfoTooltip process={process} statusReason={statusReason} /> : null;

  if (!agent) {
    if (details) return <div className="p-2.5">{details}</div>;
    // A plain session, outside advanced mode: what it is doing and where.
    if (process) {
      return (
        <div className="min-w-[220px] max-w-[320px] space-y-1 p-2.5" data-testid="tab-session-card">
          <TabTooltipName name={resolveProcessDisplayName(process) || fallbackName} />
          {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
          <p className="text-[11px] text-muted-foreground">
            {process.worker_type && <span>{workerLabel(process.worker_type)} · </span>}
            <span className="capitalize">{getDisplayStatus(process) ?? ProcessStatus.NEW}</span>
            <span> · {formatTimeAgoShort(process.updated_date)}</span>
          </p>
          {process.workdir && <WorkdirLine workdir={process.workdir} />}
        </div>
      );
    }
    // Nothing but the name yet, and a tab tip's header already shows it.
    if (inTabTip && !statusReason) return null;
    return (
      <div className="space-y-1 px-3 py-1.5">
        <TabTooltipName name={fallbackName} className="font-normal" />
        {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
      </div>
    );
  }
  return (
    <div className="w-72" data-testid="tab-agent-card">
      <AgentCardBody agent={agent} />
      {details ? (
        <div className="border-t border-border p-2.5">{details}</div>
      ) : (
        process?.workdir && (
          <WorkdirLine workdir={process.workdir} className="border-t border-border px-3 py-2" />
        )
      )}
    </div>
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
      <TabTooltipName name={tab.name || typeLabel} />
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
          <InfoRow
            label="Opened"
            value={`${formatDateTime(tab.created_date)} · ${formatTimeAgoShort(tab.created_date)}`}
          />
        )}
        {tab.updated_date && (
          <InfoRow
            label="Updated"
            value={`${formatDateTime(tab.updated_date)} · ${formatTimeAgoShort(tab.updated_date)}`}
          />
        )}
        {lastActive != null && lastActive !== '' && (
          <InfoRow
            label="Active"
            value={formatTimeAgoShort(typeof lastActive === 'number' ? new Date(lastActive) : lastActive)}
          />
        )}
      </div>
    </div>
  );
};
