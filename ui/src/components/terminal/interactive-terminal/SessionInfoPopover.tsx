/**
 * SessionInfoPopover — the "Harness Session Details" card for an
 * AgenticProcess: ids, status, times, launch flags and the copy-paste resume
 * command. It has no trigger of its own: the host (the session actions menu)
 * opens it and marks the element it hangs from with a `PopoverAnchor`.
 */

import { AgenticProcess, copyToClipboard, dataContext, openTerminalFromComputeNode, Shell } from '@sdk';
import { ClaudeSessionRecord } from '@sdk/resource_management/fs_records/claude/claude-session.js';
import { Popover, PopoverContent } from '@src/components/ui/popover';
import { Check, Copy, SquareTerminal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { buildSessionResumeCommand, getWorkerCliCapabilities } from './process-cli-presentation';
import { automationLineage } from '@src/hooks/conversation/useMessageAutomationSessions';

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

export function SessionInfoPopover({
  process,
  sessionStartTime,
  lastMessageTime,
  open,
  onOpenChange,
  children,
}: {
  process: AgenticProcess;
  sessionStartTime?: string | null;
  lastMessageTime?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The host's own controls. The card hangs from the `PopoverAnchor` among them. */
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {children}
      {/* The body mounts with the card: it runs a 1s clock and a session-record
          lookup that nothing needs while the card is closed. */}
      <PopoverContent side="bottom" align="end" className="w-96 p-0" data-testid="session-info-popover">
        <SessionInfoBody process={process} sessionStartTime={sessionStartTime} lastMessageTime={lastMessageTime} />
      </PopoverContent>
    </Popover>
  );
}

function SessionInfoBody({
  process,
  sessionStartTime,
  lastMessageTime,
}: {
  process: AgenticProcess;
  sessionStartTime?: string | null;
  lastMessageTime?: string | null;
}) {
  const { t } = useLingui();
  const cliCapabilities = getWorkerCliCapabilities(process.worker_type);
  const cliOpts = process.cliOptions;
  const workdir = process.workdir || '(not set)';
  const model = cliOpts.model || '(default)';
  const permMode = cliOpts.permission_mode;
  const chrome = cliOpts.chrome;
  const debug = cliOpts.debug;
  const worktree = cliOpts.worktree;

  const lineage = automationLineage(process);
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
    ...(lineage
      ? [[t`Caught by`, `${lineage.name ?? ''} · ${lineage.reason ?? ''} · ${Math.round((lineage.confidence ?? 0) * 100)}%`] as [string, string]]
      : []),
    [t`Status`, process.status || 'unknown'],
    [t`CLI worker status`, process.workerStatus || 'idle'],
    [t`Current Time`, currentTime],
    [t`Started`, startDisplay],
    [t`Last message`, lastDisplay],
    [t`Working Dir`, workdir],
    [t`Harness worker Session Name`, sessionName || (process.session_id ? '(loading…)' : 'none')],
    [t`Harness worker Session ID`, process.session_id || 'none'],
    // `pty_pid` lives on the linked SHELL, not on the process — reading it off
    // `process` made this row read 'none (detached)' for every live PTY.
    [t`PTY ID`, linkedShell?.pty_pid || 'none (detached)'],
    [t`Permission`, permMode],
  ];
  if (cliCapabilities.chrome) rows.push([t`Chrome`, chrome ? 'enabled' : 'disabled']);
  if (cliCapabilities.debug) rows.push([t`Debug`, debug ? 'enabled' : 'disabled']);
  if (cliCapabilities.worktree) rows.push([t`Worktree`, worktree ? 'enabled' : 'disabled']);
  rows.push([t`Model`, model]);

  return (
    <>
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
    </>
  );
}
