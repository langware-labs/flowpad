import type { AgenticProcess } from '@sdk';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';

/**
 * Shared formatting + presentation for "past chats" rows.
 *
 * Used in two surfaces:
 * 1. The chat panel's history dropdown (`EntityExecutionPanel` →
 *    `ExecutionHistoryHeader`) — the "Past chats" / "Past executions" menu
 *    that appears in the floating Flowpad Assistant chat AND in every
 *    asset-editor's chat side panel (Skill, SubAgent, Trigger, Run overlay)
 *    since they all instantiate the same panel.
 * 2. The terminal's full-screen `HistoryModal` (one-off picker).
 *
 * The two surfaces show the same data shape so a user moving between them
 * sees consistent labels (subject, project, branch, msg count, worker
 * icon) — no more "agentic_process-<uuid> · time" noise. UI density
 * differs (compact dropdown row vs. full modal row), but the *fields* are
 * identical and pulled by joining `AgenticProcess` records with the
 * worker-history backend action via `agentic_process_id`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shortId(id: string): string {
  return id.slice(0, 6);
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

/**
 * Best-guess title for a chat session. The live backing entity wins: when
 * `process.displayName` is a real name (not the `agentic_process-<id>` fallback)
 * it reflects the current `AgenticProcess.name`, which a rename
 * (tab/process/session) updates immediately. `entry.name` is a worker-history
 * snapshot that is NOT refetched on rename — so preferring it would strand the
 * renamed name out of the chats list. When the entity has no real name yet, we
 * fall through to `entry.name` (which surfaces the session subject / first
 * prompt), then the last prompt, then a short id. Keeps rename tab == rename
 * process == rename session bidirectional.
 */
export function pickHistoryTitle(
  process: AgenticProcess | null | undefined,
  entry?: WorkerHistoryEntry | null,
): string {
  const display = (process?.displayName ?? '').trim();
  if (display && !display.startsWith('agentic_process-')) {
    return clip(display);
  }
  const name = (entry?.name ?? '').trim();
  if (name && !UUID_RE.test(name) && name !== entry?.worker_id) {
    return clip(name);
  }
  // No real title — fall through to the last prompt so the row stays
  // identifiable in surfaces that show a single line (worker_history
  // splits name vs last_prompt; only HistoryModal renders both).
  const prompt = (entry?.last_prompt ?? '').trim();
  if (prompt) {
    return clip(prompt);
  }
  const id = process?.id ?? entry?.agentic_process_id ?? entry?.worker_id ?? '';
  return id ? `Session ${shortId(id)}` : 'Session';
}

/**
 * Subtitle: "<project> · <branch> · <N> msgs". Drops segments when the
 * underlying field is missing so we never render dangling separators.
 */
export function buildHistorySubline(entry?: WorkerHistoryEntry | null): string {
  if (!entry) return '';
  const parts: string[] = [];
  if (entry.project_name) parts.push(entry.project_name);
  if (entry.git_branch) parts.push(entry.git_branch);
  if (entry.message_count && entry.message_count > 0) {
    parts.push(`${entry.message_count} msg${entry.message_count === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface WorkerIconProps {
  workerType?: string | null;
  className?: string;
}

/** Tiny worker-vendor glyph. Defaults to Claude. */
export function WorkerIcon({ workerType, className = 'h-3 w-3 shrink-0' }: WorkerIconProps) {
  if (workerType === 'codex') {
    return <CodexIcon className={`${className} text-emerald-500`} />;
  }
  if (workerType === 'copilot') {
    return <CopilotIcon className={`${className} text-sky-500`} />;
  }
  return <ClaudeIcon className={`${className} text-orange-500`} />;
}
