/**
 * Pure field extractor functions for HookEventData.
 */

import { HookEventType } from './event-types';
import type { HookEventData } from './hook-event-data';

// ---------------------------------------------------------------------------
// Transcript path helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Claude transcript path into its project-encoded-name and session ID.
 * Handles paths like: /home/user/.claude/projects/-My-Project/uuid.jsonl
 * Returns null if the path doesn't match the expected format.
 */
export function parseTranscriptPath(path: string): { projectEncodedName: string; sessionId: string } | null {
  const projectsIdx = path.indexOf('.claude/projects/');
  if (projectsIdx < 0) return null;
  const remainder = path.substring(projectsIdx + '.claude/projects/'.length);
  const slashIdx = remainder.indexOf('/');
  if (slashIdx < 0) return null;
  return {
    projectEncodedName: remainder.substring(0, slashIdx),
    sessionId: remainder.substring(slashIdx + 1).replace(/\.jsonl$/, ''),
  };
}

/**
 * Compute a trigger log dock pointer from a hook entry ID.
 *
 * The hook entry ID is the trigger entity ID — the same value TriggerLogViewer
 * uses as `triggerId` to fetch `GET /trigger/{id}/log`.
 *
 * Returns null when no hook entry ID is present.
 */
export function getTriggerLogDockPointer(
  hookEntryId: string | null | undefined,
): { ref: string; options: Record<string, string> } | null {
  if (!hookEntryId) return null;
  return { ref: hookEntryId, options: {} };
}

/**
 * Compute a transcript dock pointer from hook event data.
 *
 * Phase 9: prefers `session_id` directly (single-segment ref form matching
 * `process.transcriptDockPointer`'s new shape). Falls back to parsing the
 * legacy `transcript_path` for old payloads that don't carry session_id.
 *
 * Returns null when:
 * - The event is SessionStart (transcript file not yet created on disk)
 * - Neither session_id nor a parseable transcript_path is present
 */
export function getTranscriptDockPointer(
  hookData: HookEventData,
  timestamp?: string,
): { ref: string; options: Record<string, string> } | null {
  if (hookData.hook_event_name === HookEventType.SESSION_START) return null;
  const options: Record<string, string> = {};
  if (timestamp) options.ts = timestamp;
  if (hookData.session_id) {
    return { ref: hookData.session_id, options };
  }
  if (hookData.transcript_path) {
    const parsed = parseTranscriptPath(hookData.transcript_path);
    if (parsed) {
      return { ref: parsed.sessionId, options };
    }
  }
  return null;
}

function cropText(text: string, maxWords = 5): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ') + '...';
}

/** Extract the working directory from hook event data. */
export function extractCwd(hookData: HookEventData): string | null {
  return hookData.cwd ?? null;
}

/** Extract the session ID from hook event data. */
export function extractSessionId(hookData: HookEventData): string | null {
  return hookData.session_id ?? null;
}

/** Extract the tool name from hook event data. */
export function getToolName(hookData: HookEventData): string | null {
  return hookData.tool_name ?? null;
}

/**
 * Get a single-line plain-text summary for a hook event.
 *
 * Tool events: "ToolName: key-input-detail"
 * Non-tool events: "EventName: detail"
 */
export function getEventSummaryLine(hookData: HookEventData): string {
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input;
  const eventName = hookData.hook_event_name;

  if (toolName) {
    if (toolInput) {
      const keyField =
        toolInput['command'] ||
        toolInput['file_path'] ||
        toolInput['pattern'] ||
        toolInput['url'] ||
        toolInput['query'] ||
        toolInput['description'] ||
        toolInput['prompt'] ||
        '';
      if (typeof keyField === 'string' && keyField) {
        return `${toolName}: ${cropText(keyField)}`;
      }
    }
    return toolName;
  }

  if (hookData.message) return `${eventName}: ${cropText(hookData.message)}`;
  if (hookData.prompt) return `${eventName}: ${cropText(hookData.prompt)}`;
  if (hookData.notification_type) return `${eventName}: ${hookData.notification_type}`;
  if (hookData.agent_type) return `${eventName}: ${hookData.agent_type}`;
  if (hookData.reason) return `${eventName}: ${hookData.reason}`;
  if (hookData.task_subject) return `${eventName}: ${cropText(hookData.task_subject)}`;
  if (hookData.teammate_name) return `${eventName}: ${hookData.teammate_name}`;
  if (hookData.source) return `${eventName}: ${hookData.source}`;
  if (hookData.name) return `${eventName}: ${hookData.name}`;
  if (hookData.worktree_path) return `${eventName}: ${cropText(hookData.worktree_path)}`;

  return eventName || '';
}
