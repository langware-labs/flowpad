/**
 * Type guard functions for HookEventData.
 */

import type { HookEventData } from './hook-event-data';
import { HookEventType } from './event-types';

/** Check if event is a tool event (has tool_name). */
export function isToolEvent(h: HookEventData): boolean {
  return !!h.tool_name;
}

/** Check if event is PreToolUse. */
export function isPreToolUse(h: HookEventData): boolean {
  return h.hook_event_name === HookEventType.PRE_TOOL_USE;
}

/** Check if event is PostToolUse. */
export function isPostToolUse(h: HookEventData): boolean {
  return h.hook_event_name === HookEventType.POST_TOOL_USE;
}

/** Check if event is Notification. */
export function isNotification(h: HookEventData): boolean {
  return h.hook_event_name === HookEventType.NOTIFICATION;
}

/** Check if event is Stop. */
export function isStop(h: HookEventData): boolean {
  return h.hook_event_name === HookEventType.STOP;
}

/** Check if event is UserPromptSubmit. */
export function isUserPromptSubmit(h: HookEventData): boolean {
  return h.hook_event_name === HookEventType.USER_PROMPT_SUBMIT;
}

/** Check if event is SubagentStart or SubagentStop. */
export function isSubagentEvent(h: HookEventData): boolean {
  return (
    h.hook_event_name === HookEventType.SUBAGENT_START ||
    h.hook_event_name === HookEventType.SUBAGENT_STOP
  );
}
