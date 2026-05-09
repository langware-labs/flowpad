import { ClaudeSessionRecord } from '@sdk/resource_management/fs_records/claude/claude-session';

/** Subset of AgenticProcess we depend on. Avoids a hard import + cycle risk. */
interface ProcLike {
  session_id?: string | null;
  created_date?: Date | string | null;
  cli_config?: Record<string, any>;
}

interface LoadOptionalTranscriptOptions {
  attach: boolean;
  proc?: ProcLike | null;
  projectPath?: string;
}

export interface TranscriptAttachmentResult {
  files: File[];
  attached: boolean;
  /** Populated only when the user opted in but attachment did not succeed. */
  failureReason?: string;
}

async function fetchTranscriptText(
  sessionId: string,
  projectPath: string | undefined,
): Promise<string | null> {
  const record = await ClaudeSessionRecord.discover(
    sessionId,
    projectPath ? { project: projectPath } : undefined,
  );
  const jsonlPath = record?.jsonl_path;
  if (!jsonlPath) return null;
  const res = await fetch(jsonlPath);
  if (!res.ok) return null;
  return await res.text();
}

/** True if the JSONL contains at least one user or assistant entry. */
function hasConversationContent(text: string): boolean {
  return /"type"\s*:\s*"(user|assistant)"/.test(text);
}

/**
 * Trim a Claude JSONL transcript to entries timestamped strictly before
 * `cutoffIso`. Lines without a timestamp (summary, meta) are kept.
 */
function trimJsonlByTimestamp(text: string, cutoffIso: string): string {
  const cutoff = new Date(cutoffIso).getTime();
  if (Number.isNaN(cutoff)) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = obj?.timestamp;
      if (!ts) {
        kept.push(line);
        continue;
      }
      if (new Date(ts).getTime() < cutoff) kept.push(line);
    } catch {
      // Skip malformed lines silently — Claude Code occasionally writes partial
      // lines mid-flush; we just drop them rather than fail the whole attach.
    }
  }
  return kept.join('\n');
}

function buildTranscriptFile(text: string): File {
  return new File([text], 'conversation.jsonl', { type: 'application/jsonl' });
}

function appendTranscript(files: File[], transcript: File): File[] {
  if (files.some((f) => f.name === transcript.name && f.size === transcript.size)) return files;
  return [...files, transcript];
}

/**
 * Append the Claude session transcript matching the active AgenticProcess to
 * the file list, but only when the user opted in.
 *
 * Strategy:
 *  1. Try the process's own `session_id`. If a `.jsonl` with conversation
 *     content exists, attach it as-is — the user's "now" is the natural end.
 *  2. Otherwise (forked-but-not-yet-run, rotated id, etc.) walk one level up
 *     via `cli_config.fork_session_id` and attach the parent's transcript
 *     trimmed to entries strictly before the fork's `created_date` — i.e.
 *     "what the sender knew at the moment they forked to ask for help."
 *
 * Never blocks the send. On failure returns the original files plus a
 * `failureReason` so the caller can surface a warning toast.
 */
export async function loadOptionalTranscript(
  files: File[],
  { attach, proc, projectPath }: LoadOptionalTranscriptOptions,
): Promise<TranscriptAttachmentResult> {
  if (!attach) return { files, attached: false };
  if (!proc) {
    return { files, attached: false, failureReason: 'no active AgenticProcess to attach a transcript from' };
  }

  try {
    const ownSessionId = proc.session_id ?? undefined;
    if (ownSessionId) {
      const text = await fetchTranscriptText(ownSessionId, projectPath);
      if (text && hasConversationContent(text)) {
        return { files: appendTranscript(files, buildTranscriptFile(text)), attached: true };
      }
    }

    const parentSessionId = (proc.cli_config?.fork_session_id ?? null) as string | null;
    if (!parentSessionId) {
      return {
        files,
        attached: false,
        failureReason: `no transcript on disk for session ${ownSessionId ?? '(unset)'} and no fork parent to fall back to`,
      };
    }

    const parentText = await fetchTranscriptText(parentSessionId, projectPath);
    if (!parentText || !hasConversationContent(parentText)) {
      return {
        files,
        attached: false,
        failureReason: `parent session ${parentSessionId} also has no transcript on disk`,
      };
    }

    const cutoffIso = proc.created_date
      ? new Date(proc.created_date).toISOString()
      : new Date().toISOString();
    const trimmed = trimJsonlByTimestamp(parentText, cutoffIso);
    if (!hasConversationContent(trimmed)) {
      return {
        files,
        attached: false,
        failureReason: `parent transcript ${parentSessionId} had no entries before fork point ${cutoffIso}`,
      };
    }

    return { files: appendTranscript(files, buildTranscriptFile(trimmed)), attached: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { files, attached: false, failureReason: msg };
  }
}
