import type { Task, TypeId } from '@sdk';

/**
 * Stable, deterministic chip identifiers. Each chip is keyed once so the
 * three chip rows (TaskChips / ConversationChips / MessageChips) can dedupe
 * across levels — a higher-level row tells lower-level rows what it already
 * rendered, and they skip those.
 *
 * Convention: `<kind>:<id>`. The `:<id>` keeps two chips of the same kind
 * separate when they refer to different entities.
 */

export const ChipKey = {
  project: (id?: string | null) => `project:${id ?? ''}`,
  task: (id?: string | null) => `task:${id ?? ''}`,
  spec: (id?: string | null) => `spec:${id ?? ''}`,
  process: (taskId?: string | null) => `process:${taskId ?? ''}`,
  sharedTerminal: (processId?: string | null) => `shared-terminal:${processId ?? ''}`,
  download: (messageId?: string | null) => `download:${messageId ?? ''}`,
  /** Generic key for any context-entity TypeId (``<type>:<id>``). */
  forTypeId: (typeId: TypeId) => `${typeId.type}:${typeId.id}`,
} as const;

/**
 * Chips that ``TaskChips`` would render given its inputs. Derived from
 * both context buckets (shared = wire-published links, private =
 * direct-field projections like project_id + locally-added entries) so
 * the key set tracks every chip the row will draw. Plus the task
 * self-header key.
 */
export function taskChipKeys(task: Task | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!task) return keys;
  if (task.id) keys.add(ChipKey.task(task.id));
  for (const tid of mergeContextBuckets(task)) {
    keys.add(ChipKey.forTypeId(tid));
  }
  // The process button has its own dedup key (keyed on the parent task)
  // so MessageChips can suppress a future "open Claude" chip if added.
  if (task.id) keys.add(ChipKey.process(task.id));
  return keys;
}

/** Union of two key sets, returning a fresh ``Set``. */
export function unionKeys(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set(a);
  for (const k of b) out.add(k);
  return out;
}

/** Shared then private TypeIds from an entity's context buckets, deduped by stringified TypeId. */
export function mergeContextBuckets(entity: {
  sharedContextEntities?: TypeId[] | null;
  privateContextEntities?: TypeId[] | null;
}): TypeId[] {
  const seen = new Set<string>();
  const out: TypeId[] = [];
  for (const tid of entity.sharedContextEntities ?? []) {
    const k = tid.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(tid);
  }
  for (const tid of entity.privateContextEntities ?? []) {
    const k = tid.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(tid);
  }
  return out;
}
