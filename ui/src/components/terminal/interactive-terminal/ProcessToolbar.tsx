/**
 * ProcessToolbar — icon-only toolbar for a running AgenticProcess.
 *
 * Supported vendor flags live in the CLI Options dropdown and write straight
 * to the entity. Column visibility + Trace filters live in Columns & Trace.
 *
 * Restart awareness is backend-driven: any worker-relevant change flips
 * `process.restart_required` and the top-left Restart button glows.
 */

import { AgenticProcess, copyToClipboard, dataContext, dataManager, openTerminalFromComputeNode, Shell } from '@sdk';
import { hasWorkerStarted, isProcessRunning, WorkerStatus } from '@sdk/process/agentic-types.js';
import { ClaudeSessionRecord } from '@sdk/resource_management/fs_records/claude/claude-session.js';
import { CommitMergeButton, OpenInWorktreeButton } from './WorktreeButtons';
import { ExportEntityButton } from '@src/components/entity-actions/ExportEntityButton';
import { AssetManagerButton } from '@src/components/asset-manager';
import { ViewSwap } from '@src/components/view-mode';
import { AdvancedInteractiveTabHeader, StandardInteractiveTabHeader } from './InteractiveTabHeader';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@src/components/ui/dropdown-menu';
import {
  BugPlay,
  Check,
  Copy,
  ExternalLink,
  Filter,
  GitFork,
  Info,
  RotateCcw,
  ScrollText,
  SlidersHorizontal,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { PTYViewer } from './pty-viewer';
import { PTYEventsViewer } from './pty-events-viewer';
import { CommandStatusViewer } from './command-status-viewer';
import type { ColVisibility, TraceFilters } from './InteractiveTerminal';
import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';
import {
  buildSessionResumeCommand,
  getWorkerCliCapabilities,
  type WorkerCliCapabilities,
} from './process-cli-presentation';

interface ProcessToolbarProps {
  process: AgenticProcess;
  traceFilters: TraceFilters;
  onTraceFiltersChange: (f: TraceFilters) => void;
  colVis: ColVisibility;
  onColVisChange: (v: ColVisibility) => void;
  sessionStartTime?: string | null;
  lastMessageTime?: string | null;
  /** Embedded mode: hide nav-out buttons (Open Terminal, Fork). */
  embedded?: boolean;
  /** Called when the close button is clicked (only shown when embedded=true). */
  onClose?: () => void;
  /** Shell entity for PTY Viewer (dev mode only). */
  shell?: Shell | null;
}

export function ProcessToolbar({
  process,
  traceFilters,
  onTraceFiltersChange,
  colVis,
  onColVisChange,
  sessionStartTime,
  lastMessageTime,
  embedded,
  onClose,
  shell,
}: ProcessToolbarProps) {
  const { t, i18n } = useLingui();
  const handleInjectPrompt = useCallback((text: string) => void shell?.sendInput(text + '\r'), [shell]);
  const { navigation } = useDockNavigation();
  const [showPtyViewer, setShowPtyViewer] = useState(false);
  const [showPtyEventsViewer, setShowPtyEventsViewer] = useState(false);
  const [showCommandStatus, setShowCommandStatus] = useState(false);

  // Force re-render whenever any field this toolbar reads changes. Backend
  // mutates the entity in place via castAndDeepAssign, so without an explicit
  // subscription React stays unaware of fields not already shadowed by local
  // component state. The snapshot is a composite of every entity field rendered
  // here — restart_required, the wire `status` (ready/busy), and `workerStatus`
  // — so a mid-turn status broadcast re-renders the toolbar (this is what fixes
  // the old headless-staleness: the snapshot used to read restart_required only,
  // so status/worker moves never re-rendered). Use dataManager.subscribe with
  // initialFetch=false — APIEntity.subscribe() forces initialFetch which would
  // re-invoke the snapshot during subscription and cause an update loop.
  const snapshot = () => `${process.restart_required}|${process.status}|${process.workerStatus}`;
  useSyncExternalStore(
    useCallback((cb) => dataManager.subscribe(process.typeId, cb, false), [process]),
    snapshot,
    snapshot,
  );

  const hasSession = !!process.session_id;
  const workerStatus = process.workerStatus;
  // started: process is live RIGHT NOW (gates Restart, CLI flag toggles, Apply)
  const started = isProcessRunning(process.status);
  // hasTranscript: at least one real assistant turn happened (gates Fork, Open Transcript)
  const hasTranscript = hasSession && hasWorkerStarted(workerStatus) && workerStatus !== WorkerStatus.IDLE;
  const canFork = hasTranscript;
  const canToggle = started;
  const workdir = process.workdir ?? '';

  const cliCapabilities = getWorkerCliCapabilities(process.worker_type);
  const _cliOpts = process.cliOptions;
  const currentChrome = cliCapabilities.chrome && _cliOpts.chrome;
  const currentDanger = cliCapabilities.fullTrust && _cliOpts.permission_mode === 'bypassPermissions';
  const currentDebug = cliCapabilities.debug && _cliOpts.debug;

  const [isForking, setIsForking] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const persistCliFlags = useCallback(
    async (overrides: { chrome?: boolean; danger?: boolean; debug?: boolean }) => {
      if (!canToggle) return;
      const cli = process.cliOptions;
      if (overrides.chrome !== undefined) cli.chrome = overrides.chrome;
      if (overrides.danger !== undefined) cli.permission_mode = overrides.danger ? 'bypassPermissions' : 'askUser';
      if (overrides.debug !== undefined) cli.debug = overrides.debug;
      process.cliOptions = cli;
      await process.save();
    },
    [process, canToggle],
  );

  // Console-only warning on API_TIMEOUT; the effect re-runs on status
  // transitions, so this fires once per stall.
  useEffect(() => {
    if (process.workerStatus === WorkerStatus.API_TIMEOUT) {
      console.warn(
        `[ProcessToolbar] SubAgent ${String(process.typeId)} is taking a long time to respond — the Anthropic API may be slow or unresponsive.`,
      );
    }
  }, [process.workerStatus, process.typeId]);

  const handleFork = async () => {
    if (isForking) return;
    setIsForking(true);
    try {
      const newProcess = await process.fork(true);
      void navigation.openShellProcess(newProcess.id);
    } finally {
      setIsForking(false);
    }
  };

  const handleRestart = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    try {
      await process.restart();
    } finally {
      setIsRestarting(false);
    }
  };

  const anyCliActive = currentChrome || currentDanger || currentDebug;
  // Vendor knowledge lives in the capabilities table; render its lazy descriptor here.
  const fullTrustDescription = cliCapabilities.fullTrustDescription ? i18n._(cliCapabilities.fullTrustDescription) : '';
  const anyTimeFieldActive =
    traceFilters.time ||
    traceFilters.index ||
    traceFilters.line ||
    traceFilters.absLine ||
    traceFilters.debugTime ||
    traceFilters.refTime;
  const anyColActive = !colVis.trace || !colVis.time || !colVis.annotations || anyTimeFieldActive;

  const processDisplayName = useMemo(
    () => resolveProcessDisplayName(process, 30),
    [process.context_data, process.name, process.instruction_content],
  );

  const setTrace = (key: keyof TraceFilters) => (val: boolean) => onTraceFiltersChange({ ...traceFilters, [key]: val });

  const debugSlot = (
    <>
      {/* CLI Options dropdown */}
      {(cliCapabilities.chrome || cliCapabilities.fullTrust || cliCapabilities.debug) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded transition-colors hover:bg-accent ${anyCliActive ? 'text-amber-500 dark:text-amber-400' : 'text-muted-foreground'}`}
              aria-label={t`CLI Options`}
              title={t`CLI launch options`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            {cliCapabilities.chrome && (
              <RichCheckboxItem
                checked={currentChrome}
                disabled={!canToggle}
                onCheckedChange={(v) => void persistCliFlags({ chrome: v })}
                label={t`Chrome browser`}
                description={t`Enable browser automation via Chrome (--chrome)`}
                docsUrl="https://docs.anthropic.com/en/docs/claude-code/cli-reference"
              />
            )}
            {cliCapabilities.fullTrust && (
              <RichCheckboxItem
                checked={currentDanger}
                disabled={!canToggle}
                onCheckedChange={(v) => void persistCliFlags({ danger: v })}
                label={t`Full Trust`}
                description={fullTrustDescription}
                docsUrl={cliCapabilities.fullTrustDocsUrl}
              />
            )}
            {cliCapabilities.debug && (
              <RichCheckboxItem
                checked={currentDebug}
                disabled={!canToggle}
                onCheckedChange={(v) => void persistCliFlags({ debug: v })}
                label={t`Debug logging`}
                description={t`Verbose debug output (--debug)`}
                docsUrl="https://docs.anthropic.com/en/docs/claude-code/cli-reference"
              />
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Columns & Trace dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded transition-colors hover:bg-accent ${anyColActive ? 'text-primary' : 'text-muted-foreground'}`}
            aria-label={t`Columns & Trace`}
            title={t`Column visibility & trace filters`}
          >
            <BugPlay className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            <Trans>Columns</Trans>
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={colVis.trace && traceFilters.events}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(v) => {
              if (v) {
                onColVisChange({ ...colVis, trace: true });
                onTraceFiltersChange({ ...traceFilters, events: true });
              } else {
                onColVisChange({ ...colVis, trace: false });
              }
            }}
          >
            <span className="text-xs">
              <span className="font-medium">
                <Trans>Trace events</Trans>
              </span>
              <span className="ms-1 text-muted-foreground">
                <Trans>— show trace event gutter</Trans>
              </span>
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={colVis.time}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(v) => onColVisChange({ ...colVis, time: v })}
          >
            <span className="text-xs">
              <span className="font-medium">
                <Trans>Time gutter</Trans>
              </span>
              <span className="ms-1 text-muted-foreground">
                <Trans>— show time/index gutter</Trans>
              </span>
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={colVis.annotations}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(v) => onColVisChange({ ...colVis, annotations: v })}
          >
            <span className="text-xs">
              <span className="font-medium">
                <Trans>Annotations</Trans>
              </span>
              <span className="ms-1 text-muted-foreground">
                <Trans>— show annotation gutter</Trans>
              </span>
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={traceFilters.promptAnnotations}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(v) => onTraceFiltersChange({ ...traceFilters, promptAnnotations: v })}
          >
            <span className="text-xs">
              <span className="font-medium">
                <Trans>Prompt annotations</Trans>
              </span>
              <span className="ms-1 text-muted-foreground">
                <Trans>— show prompt anchors in gutter</Trans>
              </span>
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Filter className="h-3 w-3" />
              <Trans>Time Gutter Fields</Trans>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={traceFilters.time}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={setTrace('time')}
          >
            <Trans>Time</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={traceFilters.index}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={setTrace('index')}
          >
            <Trans>Index (seq)</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={traceFilters.line}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={setTrace('line')}
          >
            <Trans>Line</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={traceFilters.absLine}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={setTrace('absLine')}
          >
            <Trans>Abs line</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={traceFilters.debugTime}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={setTrace('debugTime')}
          >
            <Trans>Row time range</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={traceFilters.refTime}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={setTrace('refTime')}
          >
            <Trans>Anchor time range</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setShowPtyViewer(true)}>
            <span className="text-xs font-medium text-amber-400">
              <Trans>PTY Viewer</Trans>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShowPtyEventsViewer(true)}>
            <span className="text-xs font-medium text-amber-400">
              <Trans>PTY Events Viewer</Trans>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShowCommandStatus(true)}>
            <span className="text-xs font-medium text-amber-400">
              <Trans>Command Status</Trans>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  // Restart — top-left, glows when backend signals process.restart_required
  const restartSlot = (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" style={!started || isRestarting ? { pointerEvents: 'auto' } : undefined}>
          <button
            data-testid="process-toolbar-restart"
            data-restart-required={process.restart_required ? 'true' : 'false'}
            className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors ${!started || isRestarting ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${
              process.restart_required && started
                ? 'animate-pulse bg-amber-500/20 text-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.55)] ring-2 ring-amber-500/60 hover:bg-amber-500/30 dark:text-amber-400'
                : 'text-muted-foreground hover:bg-accent'
            } `}
            disabled={!started || isRestarting}
            onClick={() => void handleRestart()}
            aria-pressed={process.restart_required}
            aria-label={t`Restart session`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {isRestarting
          ? t`Restarting…`
          : !started
            ? t`Session is not running`
            : process.restart_required
              ? t`Restart required — config changed since start`
              : t`Restart session`}
      </TooltipContent>
    </Tooltip>
  );

  // Entity name — absolutely centered in the header (truncated for header fit;
  // full name lives in the tab tooltip). Stays put across view modes.
  const titleSlot = !embedded && (
    <span
      className="max-w-[240px] truncate text-xs font-medium text-foreground"
      title={processDisplayName}
      data-testid="process-header-name"
    >
      {processDisplayName}
    </span>
  );

  // Share + Bookmark are NOT here: the top navigation bar carries them for
  // whatever it is addressing, this session included, and a second copy of the
  // same cluster on the same screen is the duplication that removed it from the
  // asset editor too. Export stays — the bar has no equivalent for it.
  const downloadSlot = !embedded && <ExportEntityButton typeId={process.typeId} defaultTitle={processDisplayName} />;

  const rightSlot = (
    <>
      {/* Reusable asset manager — same component the chat side panel uses. */}
      <AssetManagerButton process={process} />

      {/* Commit & Merge — worktree sessions only, prominent, left of Open Terminal */}
      {!embedded && <CommitMergeButton process={process} onInjectPrompt={handleInjectPrompt} />}

      {/* Open terminal in current folder — hidden in embedded mode */}
      {!embedded && (
        <IconToggleButton
          icon={<SquareTerminal className="h-3.5 w-3.5" />}
          active={false}
          tooltip={workdir ? t`Open terminal in ${workdir}` : t`Open terminal`}
          disabled={false}
          onClick={() => void navigation.openNewShell({ cwd: workdir || undefined })}
        />
      )}

      {/* Fork — hidden in embedded mode */}
      {!embedded && (
        <IconToggleButton
          icon={<GitFork className="h-3.5 w-3.5" />}
          active={false}
          tooltip={
            isForking
              ? t`Forking…`
              : canFork
                ? t`Fork session — new tab, same conversation history`
                : !hasSession
                  ? t`Launch a session first`
                  : !started
                    ? t`Session is not running`
                    : t`Send a message first — fork requires conversation history`
          }
          disabled={!canFork || isForking}
          onClick={() => void handleFork()}
        />
      )}

      {/* Open in Worktree — next to Fork, hidden in embedded mode */}
      {!embedded && <OpenInWorktreeButton process={process} />}

      {/* Session Info */}
      {hasSession && (
        <SessionInfoPopover
          process={process}
          cliCapabilities={cliCapabilities}
          sessionStartTime={sessionStartTime}
          lastMessageTime={lastMessageTime}
        />
      )}

      {/* Open Transcript */}
      {hasSession && (
        <IconToggleButton
          icon={<ScrollText className="h-3.5 w-3.5" />}
          active={false}
          tooltip={
            hasTranscript
              ? t`Open transcript`
              : !started
                ? t`Session is not running`
                : t`Send a message first — no transcript yet`
          }
          disabled={!hasTranscript}
          onClick={() => {
            navigation.openLens('claude', 'transcript', process.session_id!);
          }}
        />
      )}

      {/* Close — only in embedded mode */}
      {embedded && onClose && (
        <IconToggleButton
          icon={<X className="h-3.5 w-3.5" />}
          active={false}
          tooltip={t`Close terminal`}
          disabled={false}
          onClick={onClose}
        />
      )}
    </>
  );

  const advancedHeader = (
    <AdvancedInteractiveTabHeader
      debug={debugSlot}
      restart={restartSlot}
      title={titleSlot}
      download={downloadSlot}
      right={rightSlot}
    />
  );

  return (
    <TooltipProvider delayDuration={300}>
      {/* Embedded keeps the full layout; non-embedded swaps Standard/Advanced by
          the global View mode. Skin layer: same slots, different arrangement. */}
      {embedded ? (
        advancedHeader
      ) : (
        <ViewSwap advanced={advancedHeader} standard={<StandardInteractiveTabHeader title={titleSlot} />} />
      )}

      <PTYViewer open={showPtyViewer} onClose={() => setShowPtyViewer(false)} shell={shell ?? null} />
      <PTYEventsViewer open={showPtyEventsViewer} onClose={() => setShowPtyEventsViewer(false)} shell={shell ?? null} />
      <CommandStatusViewer
        open={showCommandStatus}
        onClose={() => setShowCommandStatus(false)}
        process={process ?? null}
      />
    </TooltipProvider>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RichCheckboxItem({
  checked,
  disabled,
  onCheckedChange,
  label,
  description,
  docsUrl,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  description: string;
  docsUrl?: string | null;
}) {
  const { t } = useLingui();
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className="items-start py-2"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">{label}</span>
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ms-auto text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
              aria-label={t`${label} docs`}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground">{description}</span>
      </div>
    </DropdownMenuCheckboxItem>
  );
}

function IconToggleButton({
  icon,
  active,
  tooltip,
  disabled,
  activeClassName,
  ariaLabel,
  testId,
  onClick,
}: {
  icon: React.ReactNode;
  active: boolean;
  tooltip: string;
  disabled: boolean;
  activeClassName?: string;
  ariaLabel?: string;
  testId?: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      {/* Wrap in span so tooltip fires even when the button is disabled
          (disabled elements swallow pointer events and never trigger the tooltip). */}
      <TooltipTrigger asChild>
        <span className="inline-flex" style={disabled ? { pointerEvents: 'auto' } : undefined}>
          <button
            type="button"
            className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-accent'} ${active && activeClassName ? activeClassName : 'text-muted-foreground'} `}
            disabled={disabled}
            onClick={onClick}
            aria-pressed={active}
            aria-label={ariaLabel ?? tooltip}
            data-testid={testId}
          >
            {icon}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/** Shared style for the tiny per-row icon buttons (copy / open-in-terminal). */
const ROW_ICON_BUTTON_CLASS = 'rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground';

function CopyRow({ label, value, extraAction }: { label: string; value: string; extraAction?: ReactNode }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void copyToClipboard(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="group flex gap-2 text-xs">
      <span className="w-24 shrink-0 font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 select-text break-all font-mono text-[11px]">{value}</span>
      <span className="flex shrink-0 items-start gap-0.5">
        <button
          className={`${ROW_ICON_BUTTON_CLASS} transition-opacity ${copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          onClick={handleCopy}
          title={t`Copy to clipboard`}
          aria-label={t`Copy ${label}`}
        >
          {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
        </button>
        {extraAction}
      </span>
    </div>
  );
}

function useTimeDisplay(iso: string | null | undefined): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [iso]);
  if (!iso) return '—';
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  let ago: string;
  if (sec < 60) ago = `${sec}s ago`;
  else if (sec < 3600) ago = `${Math.floor(sec / 60)}m ago`;
  else if (sec < 86400) ago = `${Math.floor(sec / 3600)}h ago`;
  else ago = `${Math.floor(sec / 86400)}d ago`;
  return `${hh}:${mm}:${ss} (${ago})`;
}

// Live "now" for the debug card: full local date-time + seconds, refreshed every
// second so a screenshot of the popover always captures the exact moment. The
// trailing ISO/UTC makes the timestamp unambiguous when cross-referencing logs.
function useCurrentTime(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${local} (${now.toISOString()})`;
}

function workerLabel(workerType: string | null | undefined): string {
  const wt = (workerType ?? '').toLowerCase();
  if (wt === 'codex') return 'Codex';
  if (wt.startsWith('claude') || wt === '') return 'Claude';
  return workerType ?? '';
}

function SessionInfoPopover({
  process,
  cliCapabilities,
  sessionStartTime,
  lastMessageTime,
}: {
  process: AgenticProcess;
  cliCapabilities: WorkerCliCapabilities;
  sessionStartTime?: string | null;
  lastMessageTime?: string | null;
}) {
  const { t } = useLingui();
  const cliOpts = process.cliOptions;
  const worker = workerLabel(process.worker_type);
  const workdir = process.workdir || '(not set)';
  const model = cliOpts.model || '(default)';
  const permMode = cliOpts.permission_mode;
  const chrome = cliOpts.chrome;
  const debug = cliOpts.debug;
  const worktree = cliOpts.worktree;

  const startDisplay = useTimeDisplay(sessionStartTime);
  const lastDisplay = useTimeDisplay(lastMessageTime);
  const currentTime = useCurrentTime();

  const [sessionName, setSessionName] = useState<string | null>(null);
  useEffect(() => {
    const sid = process.session_id;
    if (!sid) {
      setSessionName(null);
      return;
    }
    let cancelled = false;
    void ClaudeSessionRecord.discover(sid, workdir && workdir !== '(not set)' ? { project: workdir } : undefined)
      .then((record) => {
        if (!cancelled) setSessionName(record?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setSessionName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [process.session_id, workdir]);

  // Build a copy-paste-into-terminal-and-run command using each vendor's resume
  // syntax. Prefix with `cd <workdir>` so the displayed command is self-contained.
  const resumeCommand = buildSessionResumeCommand({
    workerType: process.worker_type,
    sessionId: process.session_id,
    permissionMode: permMode,
    chrome,
    debug,
    worktree,
    model: model === '(default)' ? null : model,
  });
  // Single-quote the path so spaces/metachars are safe; escape any embedded ' as '\''.
  const quoted = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const command = resumeCommand
    ? workdir && workdir !== '(not set)'
      ? `cd ${quoted(workdir)} && ${resumeCommand}`
      : resumeCommand
    : '(unsupported worker)';

  // "Open in external terminal": spawn a real OS terminal (Terminal.app / cmd /
  // gnome-terminal) via the compute node's cross-platform `open-terminal` action.
  // Pass the bare worker command + cwd separately — the backend composes the
  // `cd` itself per-OS. The displayed/copied string keeps the `cd … &&` prefix.
  const computeNodeId = dataContext.computeNode?.id;
  const openExternalTerminal = () => {
    if (!computeNodeId) return;
    if (!resumeCommand) return;
    void openTerminalFromComputeNode(
      computeNodeId,
      resumeCommand,
      workdir && workdir !== '(not set)' ? workdir : undefined,
    ).catch((e) => console.error('[SessionInfoPopover] open external terminal failed:', e));
  };

  const linkedShell = process.shell_id
    ? (Shell as unknown as { getByIdFromCache: (id: string) => Shell | null }).getByIdFromCache(process.shell_id)
    : null;

  const rows: [string, string][] = [
    [t`Process Name`, process.name || '(unnamed)'],
    [t`Process ID`, process.id || 'none'],
    [t`Shell Name`, linkedShell?.name || (process.shell_id ? '(unnamed)' : 'none')],
    [t`Shell ID`, process.shell_id || 'none'],
    [t`Status`, process.status || 'unknown'],
    [t`CLI worker status`, process.workerStatus || 'idle'],
    [t`Current Time`, currentTime],
    [t`Started`, startDisplay],
    [t`Last message`, lastDisplay],
    [t`Working Dir`, workdir],
    [t`Harness worker Session Name`, sessionName || (process.session_id ? '(loading…)' : 'none')],
    [t`Harness worker Session ID`, process.session_id || 'none'],
    [t`PTY ID`, process.pty_pid || 'none (detached)'],
    [t`Permission`, permMode],
  ];
  if (cliCapabilities.chrome) rows.push([t`Chrome`, chrome ? 'enabled' : 'disabled']);
  if (cliCapabilities.debug) rows.push([t`Debug`, debug ? 'enabled' : 'disabled']);
  if (cliCapabilities.worktree) rows.push([t`Worktree`, worktree ? 'enabled' : 'disabled']);
  rows.push([t`Model`, model]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label={t`${worker} session info`}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-96 p-0">
        <div className="border-b px-3 py-2">
          <h4 className="text-xs font-semibold">
            <Trans>Harness Session Details</Trans>
          </h4>
        </div>
        <div className="space-y-1 px-3 py-2">
          {rows.map(([label, value]) => (
            <CopyRow key={label} label={label} value={value} />
          ))}
          <CopyRow
            label={t`Command`}
            value={command}
            extraAction={
              computeNodeId &&
              resumeCommand && (
                <button
                  className={ROW_ICON_BUTTON_CLASS}
                  onClick={openExternalTerminal}
                  title={t`Open in external terminal`}
                  aria-label={t`Open command in external terminal`}
                >
                  <SquareTerminal className="h-3 w-3" />
                </button>
              )
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
