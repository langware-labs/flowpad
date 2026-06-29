import { capabilityManager, isWorkerTerminal, ProcessStatus, TypeId } from '@sdk';
import type {
  AgenticProcess,
  CapabilitiesSummary,
  CapabilityAccess,
  CapabilityDependency,
  CapabilityIntent,
  WorkerStatus,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ProcessStatusLine } from '@src/components/agentic-progress/shared/process-status-line';
import { processStatusConfig, workerStatusConfig } from '@src/components/agentic-progress/shared/status-indicator';
import { getOneLiner } from '@src/components/hooks/event-utils';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { useFlowDataTrace } from '@src/hooks/use-flow-data-trace';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { TraceEvent } from '@src/types/trace-event';
import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Sparkles,
  XCircle,
  icons as lucideIcons,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** Resolve a capability's icon (a lucide name from the backend) to a component. */
function capabilityIcon(name: string | null | undefined): LucideIcon {
  return (name && lucideIcons[name as keyof typeof lucideIcons]) || BadgeCheck;
}

/**
 * The capability's discovered typed value — the exact value workers spawn with
 * (e.g. a harness CLI's bin folder). Em-dash when typed but undiscovered;
 * hidden for untyped rows.
 */
function CapabilityValueLine({ access }: { access: CapabilityAccess }) {
  const { t } = useLingui();
  if (!access.value_type) return null;
  const value = access.value;
  const path = value && typeof value === 'object' ? (value as { path?: unknown }).path : null;
  const text = typeof path === 'string' && path ? path : null;
  return (
    <div
      className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
      data-testid="capability-value"
      title={text ?? t`No value discovered`}
    >
      {text ?? '—'}
    </div>
  );
}

function StatusBadge({ access, loading }: { access: CapabilityAccess; loading: boolean }) {
  if (loading) {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        <Trans>Checking</Trans>
      </Badge>
    );
  }
  if (!access.runnable) {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground" title={access.message}>
        <CircleHelp className="h-3 w-3" />
        <Trans>Not runnable here</Trans>
      </Badge>
    );
  }
  if (access.available) {
    return (
      <Badge className="gap-1.5 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">
        <BadgeCheck className="h-3 w-3" />
        <Trans>Available</Trans>
      </Badge>
    );
  }
  if (!access.checked) {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground">
        <CircleHelp className="h-3 w-3" />
        <Trans>Not checked</Trans>
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1.5 border-destructive/30 text-destructive">
      <XCircle className="h-3 w-3" />
      <Trans>Unavailable</Trans>
    </Badge>
  );
}

/** Dependency chips, colored by the dependency's RESOLVED availability. */
function DependencyChips({ dependencies }: { dependencies: CapabilityDependency[] }) {
  if (dependencies.length === 0) {
    return <span className="text-xs text-muted-foreground"><Trans>None</Trans></span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {dependencies.map((dep) => (
        <Badge
          key={dep.kind}
          variant="outline"
          className={cn(
            'max-w-[200px] truncate font-normal',
            dep.available
              ? 'border-emerald-200 text-emerald-700'
              : 'border-destructive/30 text-destructive',
          )}
          title={dep.available ? `${dep.kind} (available)` : `${dep.kind} (missing)`}
        >
          {dep.kind}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Ontological target picker for a CapabilityReference row (e.g. `harness` →
 * pick claude/codex/copilot). Options are runnable, non-reference siblings.
 */
function ReferenceTargetSelect({
  access,
  siblings,
  disabled,
  onChanged,
}: {
  access: CapabilityAccess;
  siblings: CapabilityAccess[];
  disabled: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const options = siblings.filter((s) => s.kind !== access.kind && s.reference_kind === null);
  const onChange = async (kind: string) => {
    await capabilityManager.setReferenceKind(access.kind, kind);
    await onChanged();
  };
  return (
    <Select value={access.reference_kind ?? undefined} onValueChange={(v) => void onChange(v)} disabled={disabled}>
      <SelectTrigger className="h-7 w-[200px] text-xs" data-testid="reference-target-select">
        <SelectValue placeholder={t`Select capability…`} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.kind} value={option.kind} data-testid={`reference-target-${option.kind}`}>
            {option.name || option.kind}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function capabilityProcessStatusLabel(process: AgenticProcess): string {
  const status = (process.status as ProcessStatus | undefined) ?? ProcessStatus.NEW;
  const procConfig = processStatusConfig[status] ?? processStatusConfig[ProcessStatus.NEW];
  const worker = (process.workerStatus ?? process.worker_status) as WorkerStatus | undefined;
  const workerConfig = worker ? workerStatusConfig[worker] : undefined;
  return worker && workerConfig && isWorkerTerminal(worker) ? workerConfig.label : procConfig.label;
}

function capabilityProcessOneLiner(process: AgenticProcess, events: TraceEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const line = getOneLiner(events[i]).trim();
    if (line) return line;
  }
  const installPrompt = process.context_data?.install_prompt;
  if (typeof installPrompt === 'string' && installPrompt.trim()) {
    return installPrompt.trim();
  }
  return process.name || 'Process started';
}

function CapabilityProcessRun({
  process,
  onOpenInTerminal,
}: {
  process: AgenticProcess;
  onOpenInTerminal: () => void;
}) {
  const { events } = useFlowDataTrace(process);
  const statusLabel = capabilityProcessStatusLabel(process);
  const oneLiner = useMemo(() => capabilityProcessOneLiner(process, events), [events, process]);
  return (
    <div className="min-w-0 space-y-0.5">
      <ProcessStatusLine process={process} size="sm" onOpenInTerminal={onOpenInTerminal} className="min-w-0" />
      <div className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground" data-testid="capability-process-one-liner">
        <span className="font-medium text-foreground/80">{statusLabel}:</span> <span>{oneLiner}</span>
      </div>
    </div>
  );
}

/** Lazily tail a capability's last/active install process by id. */
function RowProcess({ processId }: { processId: string }) {
  const { navigation } = useDockNavigation();
  const typeId = useMemo(() => {
    try {
      return new TypeId(AgenticProcess.type, processId);
    } catch {
      return null;
    }
  }, [processId]);
  const { data: process } = useEntity<AgenticProcess>(typeId, { enabled: !!typeId, watch: true });
  if (!process) return null;
  return (
    <CapabilityProcessRun
      process={process}
      onOpenInTerminal={() => navigation.openDock(process.terminalDockPointer)}
    />
  );
}

function CapabilityAccessRow({
  access,
  siblings,
  onRefresh,
}: {
  access: CapabilityAccess;
  siblings: CapabilityAccess[];
  onRefresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const Icon = capabilityIcon(access.icon);

  const runAction = useCallback(
    async (action: 'check' | 'install') => {
      setBusy(true);
      try {
        if (action === 'check') await capabilityManager.check(access.kind);
        else await capabilityManager.install(access.kind);
        await onRefresh();
      } finally {
        setBusy(false);
      }
    },
    [access.kind, onRefresh],
  );

  return (
    <div className="grid grid-cols-12 items-start gap-3 border-b px-3 py-3 last:border-b-0">
      <div className="col-span-5 flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{access.name}</span>
            {access.worker_type && (
              <Badge variant="secondary" className="shrink-0 font-normal">
                {access.worker_type}
              </Badge>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">{access.kind}</div>
          {access.description && (
            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{access.description}</div>
          )}
          <CapabilityValueLine access={access} />
        </div>
      </div>

      <div className="col-span-2">
        <StatusBadge access={access} loading={busy} />
      </div>

      <div className="col-span-2">
        {access.reference_kind ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">→</span>
            <ReferenceTargetSelect access={access} siblings={siblings} disabled={busy} onChanged={onRefresh} />
          </div>
        ) : (
          <DependencyChips dependencies={access.dependencies} />
        )}
      </div>

      <div className="col-span-2 min-w-0">
        {access.last_process_id ? (
          <RowProcess processId={access.last_process_id} />
        ) : (
          <div className="truncate text-xs text-muted-foreground/70" title={access.message}>
            {access.message || <Trans>No run</Trans>}
          </div>
        )}
      </div>

      <div className="col-span-1">
        <TooltipProvider>
          <div className="flex justify-end gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" disabled={busy} onClick={() => void runAction('check')}>
                  <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent><Trans>Refresh status</Trans></TooltipContent>
            </Tooltip>
            {access.installable && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7" disabled={busy} onClick={() => void runAction('install')}>
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent><Trans>Set up (runs an agentic process)</Trans></TooltipContent>
              </Tooltip>
            )}
            {access.last_process_id && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <OpenProcessButton processId={access.last_process_id} />
                </TooltipTrigger>
                <TooltipContent><Trans>Open process</Trans></TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      </div>
    </div>
  );
}

function OpenProcessButton({ processId }: { processId: string }) {
  const { navigation } = useDockNavigation();
  const typeId = useMemo(() => {
    try {
      return new TypeId(AgenticProcess.type, processId);
    } catch {
      return null;
    }
  }, [processId]);
  const { data: process } = useEntity<AgenticProcess>(typeId, { enabled: !!typeId, watch: false });
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      disabled={!process}
      onClick={() => process && navigation.openDock(process.terminalDockPointer)}
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </Button>
  );
}

function IntentSection({
  intent,
  onRefresh,
}: {
  intent: CapabilityIntent;
  onRefresh: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="overflow-hidden rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 bg-muted/40 px-3 py-2 text-left hover:bg-muted/60"
        onClick={() => setOpen((v) => !v)}
        data-testid={`intent-section-${intent.intent}`}
      >
        <div className="flex items-center gap-2">
          <Chevron className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{intent.label}</span>
          <span className="text-xs text-muted-foreground">({intent.capabilities.length})</span>
        </div>
        {intent.available ? (
          <Badge className="gap-1.5 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">
            <BadgeCheck className="h-3 w-3" />
            <Trans>Available</Trans>
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            <Trans>Not available</Trans>
          </Badge>
        )}
      </button>
      {open && (
        <div>
          {intent.capabilities.map((access) => (
            <CapabilityAccessRow
              key={access.kind}
              access={access}
              siblings={intent.capabilities}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** "I want …" — resolve a plain-language request to a setup agent. */
function IntentInstaller({ onLaunched }: { onLaunched: () => Promise<unknown> }) {
  const { t } = useLingui();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await capabilityManager.installIntent(value);
      setText('');
      await onLaunched();
    } finally {
      setBusy(false);
    }
  }, [text, busy, onLaunched]);

  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        placeholder={t`I want…  (e.g. email, slack, calendar)`}
        className="h-8 max-w-md text-sm"
        data-testid="capability-intent-input"
        disabled={busy}
      />
      <Button size="sm" className="h-8" disabled={busy || !text.trim()} onClick={() => void submit()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trans>Set up</Trans>}
      </Button>
    </div>
  );
}

export function CapabilitiesView() {
  const [summary, setSummary] = useState<CapabilitiesSummary | null>(() =>
    capabilityManager.getCachedSummary(),
  );

  const refresh = useCallback(async () => {
    const next = await capabilityManager.getSummary(true);
    setSummary(next);
  }, []);

  useEffect(() => {
    const sync = () => setSummary(capabilityManager.getCachedSummary());
    void capabilityManager.getSummary().then(setSummary);
    return capabilityManager.subscribe(sync);
  }, []);

  const intents = summary?.intents ?? [];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <BadgeCheck className="h-4 w-4 text-muted-foreground" />
          <div className="truncate text-sm font-medium"><Trans>Capabilities</Trans></div>
        </div>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => void refresh()}>
          <RefreshCw className="h-3.5 w-3.5" />
          <Trans>Refresh</Trans>
        </Button>
      </div>

      <IntentInstaller onLaunched={refresh} />

      <ScrollArea className="flex-1">
        <div className="space-y-3 p-4">
          {intents.length === 0 ? (
            <div className="flex items-center gap-2 px-1 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <Trans>Loading capabilities…</Trans>
            </div>
          ) : (
            intents.map((intent) => (
              <IntentSection key={intent.intent} intent={intent} onRefresh={refresh} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
