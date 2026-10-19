import { t } from '@lingui/core/macro';
import { AgenticProcess } from '@sdk';
import type { SearchResult } from '@src/hooks/use-record-search';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { notify } from '@src/notifications';
import type { SpotlightRow } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function historyDisplayName(e: WorkerHistoryEntry): string {
  const name = (e.name ?? '').trim();
  if (name && !UUID_RE.test(name) && name !== e.worker_id) return name;
  const prompt = (e.last_prompt ?? '').trim();
  if (prompt) return prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  return 'Untitled session';
}

// Reverse the encoding the indexer uses for claude projects, e.g.
// "-Users-alice-Documents-dev-flowpad-oss" → "flowpad-oss".
export function projectNameFromAssetRef(assetRef: string): string {
  const parts = assetRef.split('/');
  parts.pop();
  const encoded = parts.pop() ?? '';
  if (!encoded) return '';
  const last = encoded.split('-').filter(Boolean).pop() ?? '';
  return last;
}

export function workerIdFromSearchResult(r: SearchResult): string {
  const stem = (r.asset_ref?.split('/').pop() ?? '').replace(/\.jsonl$/i, '');
  if (r.record_type === 'codex_session' && stem.startsWith('rollout-')) {
    const segs = stem.slice('rollout-'.length).split('-');
    if (segs.length >= 5) return segs.slice(-5).join('-');
  }
  if (stem) return stem;
  return r.record_id.replace(/^(claude_session|codex_session)-/, '');
}

export function searchResultDisplayName(r: SearchResult): string {
  const title = (r.fts_title ?? '').trim();
  if (title && !UUID_RE.test(title)) return title;
  const name = (r.name ?? '').trim();
  if (name && !UUID_RE.test(name)) return name;
  const desc = (r.fts_description ?? '').trim();
  if (desc) return desc.length > 80 ? `${desc.slice(0, 80)}…` : desc;
  return 'Untitled session';
}

/** Resolve a worker_id to an AgenticProcess and open its live terminal dock.
 *  Returns `true` when navigation actually happened, `false` when no process
 *  was found (caller can then fall back to a record-type-nav path like the
 *  transcript lens). Caller is responsible for toasting on `false` if there's
 *  no fallback — when there IS a fallback the toast would be misleading.
 *
 *  @param hasFallback when true, suppress the "Session not found" toast on
 *    miss because the caller will navigate elsewhere.
 */
async function resolveProcessAndOpenTerminal(
  navigation: NavigationActions,
  workerId: string,
  agenticProcessId?: string | null,
  hasFallback = false,
): Promise<boolean> {
  let process: AgenticProcess | null = null;
  if (agenticProcessId) {
    try {
      process = (await AgenticProcess.getById(agenticProcessId)) ?? null;
    } catch {
      process = null;
    }
  }
  if (!process) {
    try {
      process = await AgenticProcess.getByWorkerId(workerId);
    } catch {
      process = null;
    }
  }
  if (!process) {
    if (!hasFallback) {
      notify.error({
        title: t`Session not found`,
        message: t`Session ${workerId} is not in Claude, Codex, or Copilot history.`,
      });
    }
    return false;
  }
  navigation.openDock(process.terminalDockPointer);
  return true;
}

export function searchResultToRow(r: SearchResult): SpotlightRow {
  const name = (r.fts_title || r.name || '').trim();
  const title = name && !UUID_RE.test(name) ? name : searchResultDisplayName(r);
  return {
    key: r.record_id,
    recordType: r.record_type,
    title,
    subtitle: projectNameFromAssetRef(r.asset_ref ?? ''),
    timestamp: r.modified_at || null,
    searchResult: r,
  };
}

/** Variant used by the terminal profile: routes click through terminalDockPointer
 *  for the live PTY, and falls back to the shared record-type-nav (transcript
 *  lens) when the process record has been pruned. Keeps `searchResult` so
 *  Spotlight's click handler can chain to `navigateToResult` if `onActivate`
 *  returns false. */
export function searchResultToTerminalRow(r: SearchResult): SpotlightRow {
  const base = searchResultToRow(r);
  const workerId = workerIdFromSearchResult(r);
  return {
    ...base,
    // hasFallback=true: suppress the "not found" toast because the caller
    // will navigate to the transcript via searchResult.
    onActivate: (navigation) => resolveProcessAndOpenTerminal(navigation, workerId, undefined, true),
  };
}

export function workerHistoryToRow(e: WorkerHistoryEntry): SpotlightRow {
  // Only these three have a session entity type. opencode deliberately has
  // none, so it gets the generic recordType and its glyph comes from
  // `vendorWorkerType` — NOT a fall-through to claude_session, which is what
  // made OpenCode results render as Claude.
  const SESSION_TYPE: Record<string, string> = {
    claude: 'claude_session',
    claude_code: 'claude_session',
    codex: 'codex_session',
    copilot: 'copilot_session',
  };
  const recordType = SESSION_TYPE[e.worker_type] ?? 'agentic_process';
  return {
    key: `${e.worker_type}:${e.worker_id}`,
    recordType,
    vendorWorkerType: e.worker_type,
    title: historyDisplayName(e),
    subtitle: e.project_name ?? '',
    timestamp: e.last_active_time ?? null,
    onActivate: (navigation) => resolveProcessAndOpenTerminal(navigation, e.worker_id, e.agentic_process_id),
  };
}
