/**
 * Parse per-dim usage entries from a raw Claude transcript JSONL string.
 *
 * Mirrors flow_sdk/transcript_analyzer/parsers/claude.py:_emit_usage. Skips
 * zero-count streams. Each assistant message produces up to 7 entries
 * (bare input + output + cache_read + cache_write_5m + cache_write_1h +
 * web_search + web_fetch).
 */

import { EntryKind } from './entry';
import { UsageEntry, type UsageEntryData } from './entries/usage';

interface RawAssistantLine {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
      server_tool_use?: {
        web_search_requests?: number;
        web_fetch_requests?: number;
      };
    };
  };
}

/** Parse raw JSONL text into a list of per-dim UsageEntry. */
export function parseClaudeTranscriptUsage(text: string): UsageEntry[] {
  const out: UsageEntry[] = [];
  if (!text) return out;
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: RawAssistantLine;
    try {
      raw = JSON.parse(line) as RawAssistantLine;
    } catch {
      continue;
    }
    if (raw.type !== 'assistant') continue;
    const msg = raw.message;
    if (!msg || !msg.usage) continue;
    const usage = msg.usage;
    const baseId = msg.id ?? raw.uuid ?? '';
    const entryId = `${baseId}:usage`;
    const envelope = {
      session_id: raw.sessionId ?? '',
      timestamp: raw.timestamp ?? '',
      worker: 'claude',
      parent_id: raw.parentUuid ?? null,
      is_sidechain: raw.isSidechain ?? false,
      entry_id: entryId,
      model: msg.model ?? null,
    };

    const emit = (fields: Partial<UsageEntryData> & { count?: number }): void => {
      const count = fields.count;
      if (typeof count !== 'number' || count <= 0) return;
      const dimId = `${baseId}:usage:dim_${out.length}`;
      out.push(
        new UsageEntry({
          ...envelope,
          id: dimId,
          count,
          io: fields.io as UsageEntryData['io'],
          unit: fields.unit,
          cache: fields.cache,
          cache_tier: fields.cache_tier,
          reasoning: fields.reasoning,
          tool: fields.tool,
        }),
      );
    };

    emit({ count: usage.input_tokens, io: 'input', cache: 'none' });
    emit({ count: usage.output_tokens, io: 'output' });
    emit({ count: usage.cache_read_input_tokens, io: 'input', cache: 'read' });

    const ce = usage.cache_creation;
    if (ce && (ce.ephemeral_5m_input_tokens || ce.ephemeral_1h_input_tokens)) {
      emit({ count: ce.ephemeral_5m_input_tokens, io: 'input', cache: 'write', cache_tier: '5m' });
      emit({ count: ce.ephemeral_1h_input_tokens, io: 'input', cache: 'write', cache_tier: '1h' });
    } else {
      // Fall back to the flat total; default to 5m (the API default when
      // cache_control doesn't specify TTL).
      emit({ count: usage.cache_creation_input_tokens, io: 'input', cache: 'write', cache_tier: '5m' });
    }

    const stu = usage.server_tool_use;
    if (stu) {
      emit({ count: stu.web_search_requests, io: 'input', unit: 'request', tool: 'web_search' });
      emit({ count: stu.web_fetch_requests, io: 'input', unit: 'request', tool: 'web_fetch' });
    }
  }
  // Reference EntryKind for typecheck pruning robustness.
  void EntryKind.TOKEN_USAGE;
  return out;
}
