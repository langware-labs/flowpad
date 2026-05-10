/**
 * Adapt the generic `AgentTranscript` (server-parsed) shape to the legacy
 * `ParsedTranscript` shape that `ClaudeTranscriptViewer` consumes.
 *
 * This is the bridge that lets us delete the client-side `parseTranscript()`
 * without rewriting the renderer: both code paths produce the same legacy
 * shape, so the rich UI (filters, search, scroll-clock, info modal, cache
 * badges, etc.) stays untouched.
 *
 * The mapping is straightforward but stateful — multiple generic entries with
 * the same base id collapse back into one legacy entry:
 *   - `assistant_message` + `tool_use` + `token_usage` (sharing base id) →
 *     a single `AssistantEntry` whose `message.content` is the original
 *     content blocks and whose `message.usage` carries the disaggregated
 *     cache fields.
 *   - `user_message` or `tool_result` → a single `UserEntry`. `tool_result`
 *     additionally re-emits `toolUseResult` from the file_path / duration_ms /
 *     exit_code fields the parser preserved.
 *
 * Anything we can't reconstruct losslessly (system / meta / progress) round-
 * trips through the renderer's "any" path — those are rendered by raw JSON
 * fallback in the renderer today.
 */

import type {
  AssistantEntry,
  ParsedTranscript,
  ProgressEntry,
  ProgressData,
  SummaryEntry,
  SystemEntry,
  TranscriptEntry,
  UserEntry,
} from '../claude-transcript/types';
import type { GenericEntry, ParsedTranscript as GenericParsed } from './entries';

/** Strip the `":usage"` suffix the python parser appends to TokenUsageEntry ids. */
function baseId(id: string): string {
  return id.endsWith(':usage') ? id.slice(0, -':usage'.length) : id;
}

interface BaseClaudeFields {
  uuid: string;
  timestamp: string;
  sessionId: string;
  parentUuid: string | null;
  isSidechain: boolean;
  userType: 'external' | 'internal';
  cwd: string;
  version: string;
  gitBranch: string;
}

function applyBase(target: Record<string, unknown>, e: GenericEntry): void {
  target.uuid = baseId(e.id);
  target.timestamp = e.timestamp;
  target.sessionId = e.session_id;
  target.parentUuid = e.parent_id ?? null;
  target.isSidechain = e.is_sidechain;
}

/**
 * Group generic entries by their `baseId` so that an assistant turn
 * (assistant_message + maybe tool_use + token_usage) lands in one bucket.
 */
function groupByBase(entries: GenericEntry[]): Map<string, GenericEntry[]> {
  const out = new Map<string, GenericEntry[]>();
  for (const e of entries) {
    const id = baseId(e.id);
    const arr = out.get(id);
    if (arr) arr.push(e);
    else out.set(id, [e]);
  }
  return out;
}

function buildAssistant(group: GenericEntry[]): AssistantEntry | null {
  const text = group.find((g) => g.kind === 'assistant_message');
  const tool = group.find((g) => g.kind === 'tool_use');
  const usage = group.find((g) => g.kind === 'token_usage');
  // Need at least one of these to call it an assistant entry.
  if (!text && !tool) return null;
  const anchor = text ?? tool!;

  const content: Record<string, unknown>[] = [];
  if (text && text.kind === 'assistant_message') {
    if (text.thinking) content.push({ type: 'thinking', thinking: text.thinking, signature: '' });
    if (text.text) content.push({ type: 'text', text: text.text });
  }
  if (tool && tool.kind === 'tool_use') {
    content.push({
      type: 'tool_use',
      id: tool.tool_use_id,
      name: tool.tool_name,
      input: tool.tool_input,
    });
  }

  const usageBlock: Record<string, number | undefined> = {};
  if (usage && usage.kind === 'token_usage') {
    if (usage.input_tokens != null) usageBlock.input_tokens = usage.input_tokens;
    if (usage.output_tokens != null) usageBlock.output_tokens = usage.output_tokens;
    if (usage.cache_read_tokens != null) usageBlock.cache_read_input_tokens = usage.cache_read_tokens;
    if (usage.cache_creation_tokens != null) usageBlock.cache_creation_input_tokens = usage.cache_creation_tokens;
  }

  const out: Record<string, unknown> = {
    type: 'assistant',
    requestId: '',
    message: {
      type: 'message',
      role: 'assistant',
      id: (anchor as { entry_id?: string }).entry_id ?? '',
      model: (anchor as { model?: string }).model ?? '',
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, ...usageBlock },
    },
  };
  applyBase(out, anchor);
  // Conversation fields the renderer reads optionally — not always present.
  out.userType = (anchor as { userType?: string }).userType ?? 'external';
  out.cwd = (anchor as { cwd?: string }).cwd ?? '';
  out.version = (anchor as { version?: string }).version ?? '';
  out.gitBranch = (anchor as { gitBranch?: string }).gitBranch ?? '';
  return out as unknown as AssistantEntry;
}

function buildUserMessage(group: GenericEntry[]): UserEntry | null {
  const msg = group.find((g) => g.kind === 'user_message');
  const tr = group.find((g) => g.kind === 'tool_result');
  const anchor = msg ?? tr;
  if (!anchor) return null;

  const content: Record<string, unknown>[] = [];
  if (msg && msg.kind === 'user_message') {
    content.push({ type: 'text', text: msg.text });
  }
  if (tr && tr.kind === 'tool_result') {
    content.push({
      type: 'tool_result',
      tool_use_id: tr.tool_use_id,
      content: tr.tool_output,
      is_error: tr.is_error,
    });
  }

  const out: Record<string, unknown> = {
    type: 'user',
    message: { role: 'user', content },
  };
  applyBase(out, anchor);
  out.userType = 'external';
  out.cwd = '';
  out.version = '';
  out.gitBranch = '';

  if (tr && tr.kind === 'tool_result') {
    const tur: Record<string, unknown> = {};
    if (tr.file_path) tur.filePath = tr.file_path;
    if (tr.duration_ms != null) tur.durationMs = tr.duration_ms;
    if (tr.exit_code != null) tur.exitCode = tr.exit_code;
    if (Object.keys(tur).length > 0) out.toolUseResult = tur;
  }
  return out as unknown as UserEntry;
}

function buildSystem(e: Extract<GenericEntry, { kind: 'system' }>): SystemEntry | ProgressEntry {
  // The python parser folds Claude's `progress` lines into SystemEntry with
  // `subtype = data.type`. The legacy renderer expects a top-level
  // `type === 'progress'` entry with a typed `data` field. Project back.
  const knownProgress = new Set(['hook_progress', 'bash_progress', 'agent_progress', 'tool_use']);
  if (knownProgress.has(e.subtype)) {
    const data: ProgressData = { type: e.subtype as 'hook_progress' | 'bash_progress' | 'agent_progress', ...(e.payload as object) } as ProgressData;
    const out: Record<string, unknown> = { type: 'progress', data };
    applyBase(out, e);
    return out as unknown as ProgressEntry;
  }
  const out: Record<string, unknown> = {
    type: 'system',
    message: typeof e.payload?.message === 'string' ? e.payload.message : JSON.stringify(e.payload),
  };
  applyBase(out, e);
  return out as unknown as SystemEntry;
}

function buildSummary(e: Extract<GenericEntry, { kind: 'summary' }>): SummaryEntry {
  const out: Record<string, unknown> = {
    type: 'summary',
    summary: e.summary_text,
    leafUuids: [],
  };
  applyBase(out, e);
  return out as unknown as SummaryEntry;
}

export function genericToLegacyTranscript(generic: GenericParsed): ParsedTranscript {
  const groups = groupByBase(generic.entries);
  const out: TranscriptEntry[] = [];
  // Iterate in original order — first appearance of each base id wins.
  const seen = new Set<string>();
  for (const e of generic.entries) {
    const id = baseId(e.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const group = groups.get(id) ?? [e];
    const kinds = new Set(group.map((g) => g.kind));

    if (kinds.has('assistant_message') || kinds.has('tool_use')) {
      const a = buildAssistant(group);
      if (a) out.push(a);
      continue;
    }
    if (kinds.has('user_message') || kinds.has('tool_result')) {
      const u = buildUserMessage(group);
      if (u) out.push(u);
      continue;
    }
    // Single-entry groups
    if (e.kind === 'system') {
      out.push(buildSystem(e));
      continue;
    }
    if (e.kind === 'summary') {
      out.push(buildSummary(e));
      continue;
    }
    // meta / token_usage / unknown — skip for renderer, the legacy view
    // doesn't render them as discrete rows. (token_usage is folded into
    // assistant entries above.)
  }

  // Header → ParsedTranscript metadata
  const header = generic.header || {};
  let startTime: Date | null = null;
  let endTime: Date | null = null;
  for (const entry of out) {
    if (entry.timestamp) {
      const t = new Date(entry.timestamp);
      if (!startTime || t < startTime) startTime = t;
      if (!endTime || t > endTime) endTime = t;
    }
  }

  return {
    entries: out,
    sessionId: generic.session_id || null,
    version: (header as { version?: string }).version ?? null,
    cwd: (header as { cwd?: string }).cwd ?? null,
    gitBranch: (header as { gitBranch?: string }).gitBranch ?? null,
    startTime,
    endTime,
  };
}
