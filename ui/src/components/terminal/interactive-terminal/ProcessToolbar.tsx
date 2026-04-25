/**
 * ProcessToolbar — icon-only toolbar for a running AgenticProcess.
 *
 * Flags (Chrome, Full Trust, Debug) are consolidated into a CLI Options dropdown.
 * Column visibility + Trace filters are consolidated into a Columns & Trace dropdown.
 *
 * Changing CLI flags requires stopping and restarting the PTY session,
 * surfaced via RestartRequiredOverlay.
 */

import { AgenticProcess, type Shell } from '@sdk';
import { hasWorkerStarted, ProcessStatus, WorkerStatus } from '@sdk/process/agentic-types.js';
import { ClaudeSessionRecord } from '@sdk/resource_management/fs_records/claude/claude-session.js';
import { CommitMergeButton, OpenInWorktreeButton } from './WorktreeButtons';
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
import { BugPlay, ExternalLink, Filter, GitFork, Info, RotateCcw, ScrollText, SlidersHorizontal, SquareTerminal, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@src/hooks/use-toast';
import { ToastAction } from '@src/components/ui/toast';
import { RestartRequiredOverlay } from './RestartRequiredOverlay';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { PTYViewer } from './pty-viewer';
import type { ColVisibility, TraceFilters } from './InteractiveTerminal';

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

export function ProcessToolbar({ process, traceFilters, onTraceFiltersChange, colVis, onColVisChange, sessionStartTime, lastMessageTime, embedded, onClose, shell }: ProcessToolbarProps) {
  const handleInjectPrompt = useCallback((text: string) => void shell?.sendInput(text + '\r'), [shell]);
  const { navigation } = useDockNavigation();
  const [showPtyViewer, setShowPtyViewer] = useState(false);

  const hasSession = !!process.session_id;
  const workerStatus = process.workerStatus;
  // started: PTY is alive RIGHT NOW (gates Restart, CLI flag toggles, Apply)
  const started = process.status === ProcessStatus.RUNNING;
  // hasTranscript: at least one real assistant turn happened (gates Fork, Open Transcript)
  const hasTranscript = hasSession
    && hasWorkerStarted(workerStatus)
    && workerStatus !== WorkerStatus.IDLE;
  const canFork = hasTranscript;
  const canToggle = started;
  const workdir = process.workdir ?? '';

  const _cliOpts = process.cliOptions;
  const currentChrome = _cliOpts.chrome;
  const currentDanger = _cliOpts.permission_mode === 'bypassPermissions';
  const currentDebug = _cliOpts.debug;

  // Local pending state
  const [pendingChrome, setPendingChrome] = useState(currentChrome);
  const [pendingDanger, setPendingDanger] = useState(currentDanger);
  const [pendingDebug, setPendingDebug] = useState(currentDebug);
  const [isApplying, setIsApplying] = useState(false);
  const [isForking, setIsForking] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  // Reset pending when entity updates
  useEffect(() => {
    setPendingChrome(currentChrome);
    setPendingDanger(currentDanger);
    setPendingDebug(currentDebug);
  }, [currentChrome, currentDanger, currentDebug]);

  // Toast when API_TIMEOUT detected — auto-dismisses if status recovers
  const { toast, dismiss } = useToast();
  const apiTimeoutToastId = useRef<string | null>(null);
  useEffect(() => {
    if (process.workerStatus === WorkerStatus.API_TIMEOUT) {
      if (apiTimeoutToastId.current) return; // already shown
      const { id } = toast({
        title: 'Agent is taking a long time to respond',
        description: 'The Anthropic API may be slow or unresponsive.',
        duration: Infinity,
        action: (
          <div className="flex gap-2">
            <ToastAction altText="Terminate" onClick={() => { void process.close(); dismiss(id); apiTimeoutToastId.current = null; }}>
              Terminate
            </ToastAction>
            <ToastAction altText="Keep Waiting" onClick={() => { dismiss(id); apiTimeoutToastId.current = null; }}>
              Keep Waiting
            </ToastAction>
          </div>
        ),
      });
      apiTimeoutToastId.current = id;
    } else if (apiTimeoutToastId.current) {
      dismiss(apiTimeoutToastId.current);
      apiTimeoutToastId.current = null;
    }
  }, [process.workerStatus]);

  const hasPendingChanges =
    pendingChrome !== currentChrome || pendingDanger !== currentDanger || pendingDebug !== currentDebug;

  const handleApply = async () => {
    setIsApplying(true);
    try {
      const updatedCli = process.cliOptions;
      updatedCli.chrome = pendingChrome;
      updatedCli.permission_mode = pendingDanger ? 'bypassPermissions' : 'askUser';
      updatedCli.debug = pendingDebug;
      process.cliOptions = updatedCli;
      await process.save();
      await process.restart();
    } finally {
      setIsApplying(false);
    }
  };

  const handleCancelChanges = () => {
    setPendingChrome(currentChrome);
    setPendingDanger(currentDanger);
    setPendingDebug(currentDebug);
  };

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

  const anyCliActive = pendingChrome || pendingDanger || pendingDebug;
  const anyTimeFieldActive = traceFilters.time || traceFilters.index || traceFilters.line || traceFilters.absLine || traceFilters.debugTime || traceFilters.refTime;
  const anyColActive = !colVis.trace || !colVis.time || !colVis.annotations || anyTimeFieldActive;

  const setTrace = (key: keyof TraceFilters) => (val: boolean) =>
    onTraceFiltersChange({ ...traceFilters, [key]: val });

  return (
    <TooltipProvider delayDuration={300}>
      <div data-testid="process-toolbar" className="flex items-center gap-0.5 border-b bg-muted/30 px-2 py-1">

        {/* CLI Options dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded transition-colors hover:bg-accent ${anyCliActive ? 'text-amber-500 dark:text-amber-400' : 'text-muted-foreground'}`}
              aria-label="CLI Options"
              title="CLI launch options"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <RichCheckboxItem
              checked={pendingChrome}
              disabled={!canToggle}
              onCheckedChange={(v) => canToggle && setPendingChrome(v)}
              label="Chrome browser"
              description="Enable browser automation via Chrome (--chrome)"
              docsUrl="https://docs.anthropic.com/en/docs/claude-code/cli-reference"
            />
            <RichCheckboxItem
              checked={pendingDanger}
              disabled={!canToggle}
              onCheckedChange={(v) => canToggle && setPendingDanger(v)}
              label="Full Trust"
              description="Skip all permission prompts (--dangerously-skip-permissions)"
              docsUrl="https://docs.anthropic.com/en/docs/claude-code/settings"
            />
            <RichCheckboxItem
              checked={pendingDebug}
              disabled={!canToggle}
              onCheckedChange={(v) => canToggle && setPendingDebug(v)}
              label="Debug logging"
              description="Verbose debug output (--debug)"
              docsUrl="https://docs.anthropic.com/en/docs/claude-code/cli-reference"
            />
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Columns & Trace dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded transition-colors hover:bg-accent ${anyColActive ? 'text-primary' : 'text-muted-foreground'}`}
              aria-label="Columns & Trace"
              title="Column visibility & trace filters"
            >
              <BugPlay className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Columns</DropdownMenuLabel>
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
                <span className="font-medium">Trace events</span>
                <span className="ml-1 text-muted-foreground">— show trace event gutter</span>
              </span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={colVis.time}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(v) => onColVisChange({ ...colVis, time: v })}
            >
              <span className="text-xs">
                <span className="font-medium">Time gutter</span>
                <span className="ml-1 text-muted-foreground">— show time/index gutter</span>
              </span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={colVis.annotations}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(v) => onColVisChange({ ...colVis, annotations: v })}
            >
              <span className="text-xs">
                <span className="font-medium">Annotations</span>
                <span className="ml-1 text-muted-foreground">— show annotation gutter</span>
              </span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={traceFilters.promptAnnotations}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(v) => onTraceFiltersChange({ ...traceFilters, promptAnnotations: v })}
            >
              <span className="text-xs">
                <span className="font-medium">Prompt annotations</span>
                <span className="ml-1 text-muted-foreground">— show prompt anchors in gutter</span>
              </span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Filter className="h-3 w-3" />
                Time Gutter Fields
              </span>
            </DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={traceFilters.time} onSelect={(e) => e.preventDefault()} onCheckedChange={setTrace('time')}>
              Time
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={traceFilters.index} onSelect={(e) => e.preventDefault()} onCheckedChange={setTrace('index')}>
              Index (seq)
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={traceFilters.line} onSelect={(e) => e.preventDefault()} onCheckedChange={setTrace('line')}>
              Line
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={traceFilters.absLine} onSelect={(e) => e.preventDefault()} onCheckedChange={setTrace('absLine')}>
              Abs line
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={traceFilters.debugTime} onSelect={(e) => e.preventDefault()} onCheckedChange={setTrace('debugTime')}>
              Row time range
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={traceFilters.refTime} onSelect={(e) => e.preventDefault()} onCheckedChange={setTrace('refTime')}>
              Anchor time range
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setShowPtyViewer(true)}>
              <span className="text-amber-400 text-xs font-medium">PTY Viewer</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Commit & Merge — worktree sessions only, prominent, left of Open Terminal */}
        {!embedded && (
          <CommitMergeButton process={process} onInjectPrompt={handleInjectPrompt} />
        )}

        {/* Open terminal in current folder — hidden in embedded mode */}
        {!embedded && (
          <IconToggleButton
            icon={<SquareTerminal className="h-3.5 w-3.5" />}
            active={false}
            tooltip={workdir ? `Open terminal in ${workdir}` : 'Open terminal'}
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
              isForking ? 'Forking…'
              : canFork ? 'Fork session — new tab, same conversation history'
              : !hasSession ? 'Launch a session first'
              : !started ? 'Session is not running'
              : 'Send a message first — fork requires conversation history'
            }
            disabled={!canFork || isForking}
            onClick={() => void handleFork()}
          />
        )}

        {/* Open in Worktree — next to Fork, hidden in embedded mode */}
        {!embedded && <OpenInWorktreeButton process={process} />}

        {/* Restart */}
        <IconToggleButton
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          active={false}
          tooltip={
            isRestarting ? 'Restarting…'
            : started ? 'Restart session'
            : 'Session is not running'
          }
          disabled={!started || isRestarting}
          onClick={() => void handleRestart()}
        />

        {/* Session Info */}
        {hasSession && <SessionInfoPopover process={process} sessionStartTime={sessionStartTime} lastMessageTime={lastMessageTime} />}

        {/* Open Transcript */}
        {hasSession && (
          <IconToggleButton
            icon={<ScrollText className="h-3.5 w-3.5" />}
            active={false}
            tooltip={
              hasTranscript ? 'Open transcript'
              : !started ? 'Session is not running'
              : 'Send a message first — no transcript yet'
            }
            disabled={!hasTranscript}
            onClick={() => {
              void (async () => {
                const sessionId = process.session_id!;
                const record = await ClaudeSessionRecord.discover(sessionId).catch(() => null);
                const projectEncodedName = record?.project_encoded_name ?? workdir.replace(/\//g, '-');
                navigation.openLens('claude', 'transcript', `${projectEncodedName}/${sessionId}`);
              })();
            }}
          />
        )}

        {/* Close — only in embedded mode */}
        {embedded && onClose && (
          <IconToggleButton
            icon={<X className="h-3.5 w-3.5" />}
            active={false}
            tooltip="Close terminal"
            disabled={false}
            onClick={onClose}
          />
        )}

      </div>

      {/* Restart overlay — positioned by parent's relative container over terminal content */}
      {hasPendingChanges && canToggle && (
        <RestartRequiredOverlay
          onRestart={() => void handleApply()}
          onCancel={handleCancelChanges}
          isRestarting={isApplying}
        />
      )}

      <PTYViewer open={showPtyViewer} onClose={() => setShowPtyViewer(false)} shell={shell ?? null} />
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
  docsUrl: string;
}) {
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
          <a
            href={docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
            aria-label={`${label} docs`}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
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
  onClick,
}: {
  icon: React.ReactNode;
  active: boolean;
  tooltip: string;
  disabled: boolean;
  activeClassName?: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      {/* Wrap in span so tooltip fires even when the button is disabled
          (disabled elements swallow pointer events and never trigger the tooltip). */}
      <TooltipTrigger asChild>
        <span className="inline-flex" style={disabled ? { pointerEvents: 'auto' } : undefined}>
          <button
            className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors
              ${disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-accent cursor-pointer'}
              ${active && activeClassName ? activeClassName : 'text-muted-foreground'}
            `}
            disabled={disabled}
            onClick={onClick}
            aria-pressed={active}
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

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-24 shrink-0 font-medium text-muted-foreground">{label}</span>
      <button
        className="break-all text-left font-mono text-[11px] hover:text-foreground cursor-copy"
        onClick={handleCopy}
        title="Click to copy"
      >
        {copied ? <span className="text-green-500">Copied!</span> : value}
      </button>
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

function SessionInfoPopover({ process, sessionStartTime, lastMessageTime }: { process: AgenticProcess; sessionStartTime?: string | null; lastMessageTime?: string | null }) {
  const cliOpts = process.cliOptions;
  const workdir = process.workdir || '(not set)';
  const model = cliOpts.model || '(default)';
  const permMode = cliOpts.permission_mode;
  const chrome = cliOpts.chrome;
  const debug = cliOpts.debug;
  const worktree = cliOpts.worktree;

  const startDisplay = useTimeDisplay(sessionStartTime);
  const lastDisplay = useTimeDisplay(lastMessageTime);

  // Use ClaudeCliCommand for the display string
  const parts = ['claude'];
  if (permMode === 'bypassPermissions') parts.push('--dangerously-skip-permissions');
  if (chrome) parts.push('--chrome');
  if (debug) parts.push('--debug');
  if (worktree) parts.push('--worktree');
  parts.push('--session-id', process.session_id || '?');
  if (model && model !== '(default)') parts.push('--model', model);
  const command = parts.join(' ');

  const rows: [string, string][] = [
    ['Process ID', process.id || 'none'],
    ['Status', process.status || 'unknown'],
    ['CLI worker status', process.workerStatus || 'idle'],
    ['Started', startDisplay],
    ['Last message', lastDisplay],
    ['Working Dir', workdir],
    ['Session ID', process.session_id || 'none'],
    ['PTY ID', process.pty_pid || 'none (detached)'],
    ['Permission', permMode],
    ['Chrome', chrome ? 'enabled' : 'disabled'],
    ['Debug', debug ? 'enabled' : 'disabled'],
    ['Worktree', worktree ? 'enabled' : 'disabled'],
    ['Model', model],
    ['Command', command],
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Session info"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-96 p-0">
        <div className="border-b px-3 py-2">
          <h4 className="text-xs font-semibold">Session Details</h4>
        </div>
        <div className="space-y-1 px-3 py-2">
          {rows.map(([label, value]) => (
            <CopyRow key={label} label={label} value={value} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
