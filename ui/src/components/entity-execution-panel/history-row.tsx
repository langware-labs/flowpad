import type { AgenticProcess } from '@sdk';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { providerMetaFor } from '@src/tabs/provider-meta';

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

function shortId(id: string): string {
  return id.slice(0, 6);
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

/**
 * Render the backend-resolved name. A live process carries newer broadcasts
 * than the history snapshot. Unbound history rows use the backend's entry.name;
 * neither surface invents a title from prompts or rejects an explicit name.
 */
export function pickHistoryTitle(
  process: AgenticProcess | null | undefined,
  entry?: WorkerHistoryEntry | null,
): string {
  const name = ((process ? process.name : entry?.name) ?? '').trim();
  if (name) return clip(name);
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

interface WorkerIconProps {
  workerType?: string | null;
  className?: string;
}

/** Tiny worker-vendor glyph, resolved through `PROVIDER_META`.
 *
 *  Deliberately NOT a per-vendor if-ladder. This used to enumerate codex and
 *  copilot and fall through to Claude, so opencode rendered — and announced to
 *  screen readers — as Claude. A fall-through that names a real vendor fails
 *  silently and plausibly, which is why it survived. Reading the shared table
 *  instead means the next vendor is correct here the moment it is added there,
 *  with no edit to this file. */
export function WorkerIcon({ workerType, className = 'h-3 w-3 shrink-0' }: WorkerIconProps) {
  const meta = providerMetaFor(workerType);
  return <meta.Icon className={`${className} ${meta.iconClassName}`} />;
}
