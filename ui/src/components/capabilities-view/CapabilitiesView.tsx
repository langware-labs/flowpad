import { useCapability } from '@sdk/react/hooks';
import { capabilityManager, isWorkerTerminal, ProcessStatus } from '@sdk';
import type { AgenticProcess, Capability, CapabilityResult, WorkerStatus } from '@sdk';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { useEffect, useMemo, useState } from 'react';
import { ProcessStatusLine } from '@src/components/agentic-progress/shared/process-status-line';
import { processStatusConfig, workerStatusConfig } from '@src/components/agentic-progress/shared/status-indicator';
import { getOneLiner } from '@src/components/hooks/event-utils';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { ScrollArea } from '@src/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@src/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { useFlowDataTrace } from '@src/hooks/use-flow-data-trace';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { TraceEvent } from '@src/types/trace-event';
import {
  BadgeCheck,
  CircleHelp,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
  icons as lucideIcons,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** Resolve a capability's icon (a lucide name persisted on the entity) to a component. */
function capabilityIcon(name: string | null | undefined): LucideIcon {
  return (name && lucideIcons[name as keyof typeof lucideIcons]) || BadgeCheck;
}

/**
 * Ontological target picker for a CapabilityReference row. Options are the
 * concrete capabilities under the reference's own branch (e.g. `harness` →
 * `harness.*`), excluding other references.
 */
function ReferenceTargetSelect({
  capability,
  candidates,
  disabled,
  onChanged,
}: {
  capability: Capability;
  candidates: Capability[];
  disabled: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const options = candidates.filter((c) => c.kind !== capability.kind && !c.reference_kind);
  const onChange = async (kind: string) => {
    capability.reference_kind = kind;
    await capability.save();
    await onChanged();
  };
  return (
    <Select value={capability.reference_kind ?? undefined} onValueChange={(v) => void onChange(v)} disabled={disabled}>
      <SelectTrigger className="h-7 w-[200px] text-xs" data-testid="reference-target-select">
        <SelectValue placeholder="Select capability…" />
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

function resultLabel(result: CapabilityResult | null): string {
  if (!result) return 'Not checked';
  if (result.available) return 'Available';
  if (result.ok) return 'Ready';
  return 'Unavailable';
}

/**
 * The capability's discovered typed value — the exact value workers spawn
 * with (e.g. the harness CLI's bin folder), so the window always shows what
 * the system actually uses. Em-dash when the capability has a typed slot
 * (value_type set) but discovery found nothing; hidden for untyped rows.
 */
function CapabilityValueLine({ capability }: { capability: Capability | null }) {
  if (!capability?.value_type) return null;
  const path =
    capability.value && typeof capability.value === 'object'
      ? (capability.value as { path?: unknown }).path
      : null;
  const text = typeof path === 'string' && path ? path : null;
  return (
    <div
      className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
      data-testid="capability-value"
      title={text ?? 'No value discovered'}
    >
      {text ?? '—'}
    </div>
  );
}

function ResultBadge({ result, loading }: { result: CapabilityResult | null; loading: boolean }) {
  if (loading) {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking
      </Badge>
    );
  }

  if (!result) {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground">
        <CircleHelp className="h-3 w-3" />
        Not checked
      </Badge>
    );
  }

  if (result.available) {
    return (
      <Badge className="gap-1.5 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-50">
        <BadgeCheck className="h-3 w-3" />
        {resultLabel(result)}
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="gap-1.5 border-destructive/30 text-destructive">
      <XCircle className="h-3 w-3" />
      {resultLabel(result)}
    </Badge>
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
        <span className="font-medium text-foreground/80">{statusLabel}:</span>{' '}
        <span>{oneLiner}</span>
      </div>
    </div>
  );
}

function CapabilityRow({ kind }: { kind: string }) {
  const {
    capability,
    capabilities,
    result,
    isLoading,
    error,
    activeProcess,
    check,
    install,
  } = useCapability(kind);
  const { navigation } = useDockNavigation();

  const Icon = capabilityIcon(capability?.icon);
  const title = capability?.name ?? kind;
  const description = capability?.description ?? '';
  const dependencies = capability?.dependent_capability_kinds ?? [];
  const hasCapability = capabilities.length > 0;
  const busy = isLoading;
  const actionsDisabled = busy || !hasCapability;
  const message = error instanceof Error ? error.message : result?.message;

  return (
    <TableRow>
      <TableCell className="w-[34%] min-w-[220px]">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/40">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{title}</div>
            <div className="truncate text-xs text-muted-foreground">{kind}</div>
            {description && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{description}</div>}
            <CapabilityValueLine capability={capability} />
          </div>
        </div>
      </TableCell>

      <TableCell className="w-[14%]">
        <ResultBadge result={result} loading={busy && !result} />
      </TableCell>

      <TableCell className="w-[22%]">
        {capability?.reference_kind ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">→</span>
            <ReferenceTargetSelect
              capability={capability}
              candidates={capabilities}
              disabled={busy}
              onChanged={check}
            />
          </div>
        ) : dependencies.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {dependencies.map((kind) => (
              <Badge key={kind} variant="outline" className="max-w-[180px] truncate font-normal">
                {kind}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">None</span>
        )}
      </TableCell>

      <TableCell className="w-[20%]">
        {activeProcess ? (
          <CapabilityProcessRun
            process={activeProcess}
            onOpenInTerminal={() => navigation.openDock(activeProcess.terminalDockPointer)}
          />
        ) : (
          <div className={cn('truncate text-xs', message ? 'text-muted-foreground' : 'text-muted-foreground/70')}>
            {message ?? 'No run'}
          </div>
        )}
      </TableCell>

      <TableCell className="w-[10%]">
        <TooltipProvider>
          <div className="flex justify-end gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={actionsDisabled}
                  onClick={() => void check()}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh status</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={actionsDisabled}
                  onClick={() => void install()}
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Install (runs an agentic process)</TooltipContent>
            </Tooltip>

            {activeProcess && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => navigation.openDock(activeProcess.terminalDockPointer)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open process</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      </TableCell>
    </TableRow>
  );
}

export function CapabilitiesView() {
  // Rows come from the backend registry (system capability entities) — no
  // hardcoded kind list to keep in sync. Sorted by kind so ontology branches
  // group naturally (harness, harness.claude.cli, …).
  const [kinds, setKinds] = useState<string[]>([]);
  useEffect(() => {
    const sync = () =>
      setKinds(
        capabilityManager
          .getAll()
          .map((c) => c.kind)
          .sort((a, b) => a.localeCompare(b)),
      );
    void capabilityManager.load().then(sync);
    return capabilityManager.subscribe(sync);
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <BadgeCheck className="h-4 w-4 text-muted-foreground" />
          <div className="truncate text-sm font-medium">Capabilities</div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Capability</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Depends On</TableHead>
                <TableHead>Last Run</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {kinds.map((kind) => (
                <CapabilityRow key={kind} kind={kind} />
              ))}
            </TableBody>
          </Table>
        </div>
      </ScrollArea>
    </div>
  );
}
