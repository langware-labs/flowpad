import { FlowData, isTypeId, type ReceiveShowTarget, TypeId } from '@sdk';
import {
  describeToolInput,
  describeToolName,
} from '@src/components/flowdata-renderer/ToolCallMessageComponent';
import {
  Bot,
  FileDiff,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  type LucideIcon,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from 'lucide-react';

/**
 * What a chip opens when clicked, or null when it opens nothing (the row stays
 * a plain expander; the raw payload is still one chevron away).
 *
 * Deliberately the backend's own `ReceiveShowTarget` shape rather than a
 * chip-local type: `flow show file` / `flow show entity` post exactly this, and
 * `openDisplayTarget` already knows how to route every variant of it.
 */
export type ChipTarget = ReceiveShowTarget | null;

const filePath = (path: string): ChipTarget => (path ? { kind: 'vfs', path } : null);

export interface EventDescriptor {
  /** Semantic entry kind ('file_read', 'flow_command', …) or 'tool_use'. */
  kind: string;
  icon: LucideIcon;
  /** Short human label — "Read", "flow show", "Using skill". */
  label: string;
  /** One-liner detail: a path, a command, a target. Truncated by the caller. */
  detail: string;
  target: ChipTarget;
}

/** The typed entry the backend attached to this frame, when there is one. */
export function transcriptEntry(fd: FlowData): Record<string, unknown> | null {
  const pe = fd.processEntry;
  if (!pe || typeof pe !== 'object') return null;
  const entry = (pe as { transcript_entry?: unknown }).transcript_entry;
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The three file kinds differ only in glyph and verb — everything else (the
 * path, the file target) is one rule, so it lives in one place.
 */
const FILE_OPS: Record<string, [LucideIcon, string]> = {
  file_read: [FileText, 'Read'],
  file_write: [FilePlus, 'Write'],
  file_edit: [FileDiff, 'Edit'],
};

/**
 * Describe one dense-row event for rendering.
 *
 * Reads the CONSOLIDATED signal first — the typed `process_entry.transcript_entry`
 * the backend attaches identically on the live stream and on replay — so the chip
 * never has to sniff tool names or regex payloads. Falls back to `subtype`, then
 * to the legacy `tool-name` description for frames predating the consolidation.
 */
export function describeEvent(fd: FlowData): EventDescriptor {
  const entry = transcriptEntry(fd);
  const kind = str(entry?.kind) || fd.attributes['subtype'] || '';
  const toolName = fd.attributes['tool-name'] || 'Tool';

  const fileOp = FILE_OPS[kind];
  if (fileOp) {
    const path = str(entry?.path) || describeToolInput(fd.data);
    const [icon, label] = fileOp;
    return { kind, icon, label, detail: path, target: filePath(path) };
  }

  switch (kind) {
    case 'flow_command': {
      const verb = str(entry?.verb) || fd.attributes['flow-verb'];
      const target = str(entry?.target) || fd.attributes['flow-target'];
      const subverb = str(entry?.subverb) || fd.attributes['flow-subverb'];
      return {
        kind,
        icon: Zap,
        label: verb ? `flow ${verb}` : 'flow',
        detail: target || str(entry?.command) || describeToolInput(fd.data),
        target: flowTarget(subverb, target),
      };
    }
    case 'skill_call': {
      const name = str(entry?.skill_name) || fd.attributes['skill-name'];
      return {
        kind,
        icon: Sparkles,
        label: 'Using skill',
        detail: name,
        // Display-only here: the clickable skill affordance is the top-level
        // meta chip (which has the skill's folder path to resolve with).
        target: null,
      };
    }
    case 'shell_command':
      return {
        kind,
        icon: Terminal,
        label: 'Run',
        detail: str(entry?.command) || describeToolInput(fd.data),
        target: null,
      };
    case 'search':
      return {
        kind,
        icon: Search,
        label: str(entry?.search_kind) || 'Search',
        detail: str(entry?.query) || describeToolInput(fd.data),
        target: null,
      };
    case 'web_fetch':
      return {
        kind,
        icon: Globe,
        label: 'Fetch',
        detail: str(entry?.url) || str(entry?.query) || describeToolInput(fd.data),
        target: null,
      };
    case 'todo_update':
      return { kind, icon: ListTodo, label: 'Todos', detail: '', target: null };
    case 'agent_spawn':
      return {
        kind,
        icon: Bot,
        label: 'SubAgent',
        detail: str(entry?.agent_type) || str(entry?.description),
        target: null,
      };
    default:
      // Pre-consolidation frames, MCP tools, and anything the backend maps to
      // the catch-all keep the legacy naming — never a blank row.
      return {
        kind: kind || 'tool_use',
        icon: Wrench,
        label: describeToolName(toolName),
        detail: describeToolInput(fd.data),
        target: null,
      };
  }
}

/**
 * `flow show entity <typeid>` opens that entity; `flow show file <path>` opens
 * the file. Anything else (a bare `flow record`, an unrecognized target) stays
 * a payload popover rather than guessing a destination.
 */
function flowTarget(subverb: string, target: string): ChipTarget {
  if (!target) return null;
  // `isTypeId`, never a local regex: a stricter copy here rejects the uname and
  // key forms TypeId accepts (`project-@local`), silently dropping the chip.
  if (subverb === 'entity' && isTypeId(target)) {
    return { kind: 'entity', typeid: target, type: new TypeId(target).type };
  }
  if (subverb === 'file') return filePath(target);
  return null;
}
