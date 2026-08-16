import { FlowData, FlowElementTypes } from '@sdk';

import type { TurnGroup } from './groupTurnEvents';
import { transcriptEntry } from './transcriptEntry';

/**
 * "Files this turn touched" — the trace behind the chat's per-turn chip row.
 *
 * Why this exists: Standard mode ships with "Show tool calls" OFF
 * (`preferences.chat.show_tools`, default false), so a turn that writes files
 * renders as prose with nothing to click. The writes are already on the wire —
 * the backend attaches a typed `FileWriteEntry`/`FileEditEntry` to every frame,
 * identically on the live stream and on replay — so the chips are a pure read
 * of what the chat already has.
 *
 * Two kinds, kept apart because they answer different questions ("what is new
 * here?" vs "what changed?"):
 *
 *   - `create` — a `file_write` entry (Claude `Write`, Codex `apply_patch ***
 *     Add File`). Note the backend hardcodes `is_new=True` on every
 *     `FileWriteEntry`, so re-writing an existing file also reads as a
 *     creation; the guard below is defensive, not a real did-not-exist test.
 *   - `edit` — a `file_edit` entry (Claude `Edit`/`MultiEdit`/`NotebookEdit`,
 *     Codex `apply_patch *** Update File`).
 *
 * A `flow artifact` registration is deliberately NOT here — it already has its
 * own chip in the bottom ribbon.
 */
export type FileChange = 'create' | 'edit';

export interface TurnFile {
  /**
   * The path exactly as the transcript entry carried it — ABSOLUTE for Claude,
   * cwd-RELATIVE for Codex `apply_patch`. Resolving it to something openable is
   * `turnFileVfsPath`'s job, not this module's.
   */
  path: string;
  /** Display label: the basename, split on both separators (Windows paths). */
  name: string;
  change: FileChange;
}

const NO_FILES: readonly TurnFile[] = Object.freeze([]);

/**
 * Basename, splitting on `/` AND `\`.
 *
 * Deliberately not `asset-row-helpers`' `basename`, which only knows `/`:
 * Claude on Windows emits `C:\Users\…\x.ts` verbatim, and that helper would
 * hand the whole absolute path back as the chip label.
 */
function fileNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

const CHANGE_OF_KIND: Record<string, FileChange> = {
  file_write: 'create',
  file_edit: 'edit',
};

/** What a frame did to a file, or null when it touched no file. */
function fileTouchedBy(event: FlowData): TurnFile | null {
  if (event.elementType !== FlowElementTypes.TOOL_CALL) return null;
  const entry = transcriptEntry(event);
  if (!entry) return null;
  const change = CHANGE_OF_KIND[String(entry.kind)];
  if (!change) return null;
  // A failed operation changed nothing; `is_new: false` on a write would mean a
  // plain overwrite rather than a creation.
  if (entry.is_error === true) return null;
  if (change === 'create' && entry.is_new === false) return null;
  const path = entry.path;
  if (typeof path !== 'string' || !path) return null;
  return { path, name: fileNameOf(path), change };
}

/**
 * Collect into `into`, keyed by path, with CREATE OUTRANKING EDIT.
 *
 * A turn that writes a file and then tweaks it — `Write` then `Edit`, the
 * single commonest shape — must chip it once, as created. Order doesn't help:
 * the edit can be seen first (an earlier group edits, a later one rewrites), so
 * a later create upgrades an entry already recorded as an edit.
 */
function collect(into: Map<string, TurnFile>, files: Iterable<TurnFile>): void {
  for (const file of files) {
    const seen = into.get(file.path);
    if (!seen) {
      into.set(file.path, file);
    } else if (seen.change === 'edit' && file.change === 'create') {
      into.set(file.path, file);
    }
  }
}

/**
 * Per-group memo. Committed groups keep their object identity across live
 * appends (`createTurnGrouper`), so a streaming frame costs O(new events)
 * instead of re-scanning the whole history — the same constraint that made the
 * grouper incremental in the first place (QA D10). It also gives the rendered
 * chip row a stable `files` identity to memoize on.
 */
const groupFiles = new WeakMap<TurnGroup, readonly TurnFile[]>();

/**
 * Files one group touched, deduped by path, in first-seen order.
 *
 * Reads `group.events`, NOT the raw item stream, on purpose: the grouper
 * RETRACTS a row when a refinement of it arrives (`createTurnGrouper`'s
 * `retract` — a `shell_command → flow_command → artifact` chain collapses to
 * its leaf). Tracing the group inherits that suppression for free, so the chips
 * can never surface an operation the chat itself decided not to render.
 */
export function filesInGroup(group: TurnGroup): readonly TurnFile[] {
  if (group.kind !== 'dense') return NO_FILES;
  const cached = groupFiles.get(group);
  if (cached) return cached;

  const byPath = new Map<string, TurnFile>();
  for (const event of group.events) {
    const file = fileTouchedBy(event);
    if (file) collect(byPath, [file]);
  }

  const result = byPath.size > 0 ? Object.freeze([...byPath.values()]) : NO_FILES;
  groupFiles.set(group, result);
  return result;
}

/**
 * Does this group START a real turn?
 *
 * A turn runs from one user message to the next — but only a HUMAN one.
 * Framework injections (skill bodies, command expansions, the Flowpad prompt
 * envelope) arrive as `is-meta` USER_MESSAGE frames; treating those as turn
 * starts would chop one turn into several and scatter its files.
 */
export function isTurnStart(group: TurnGroup): boolean {
  if (group.kind !== 'message') return false;
  const fd = group.flowData;
  if (fd.attributes?.['is-meta'] === 'true') return false;
  return fd.elementType === FlowElementTypes.USER_MESSAGE || fd.attributes?.role === 'user';
}

export interface TurnFilesPlan {
  /**
   * Visible-row index → the files to render after that row. The key is an index
   * into the RENDERED sequence, not into `groups`, because the caller filters
   * dense groups out when "Show tool calls" is off — and that is exactly the
   * case this feature exists for. `-1` means "before the first rendered row"
   * (a turn whose every group was filtered out).
   */
  readonly byRow: ReadonlyMap<number, readonly TurnFile[]>;
}

/**
 * Where each ended turn's chip row goes.
 *
 * Turn boundaries are the only boundaries available: `END`/`RESULT` frames are
 * dropped by the grouper AND are never emitted on replay, so after a browser
 * reload they do not exist at all. A turn is therefore ended when a LATER user
 * message exists; the trailing turn needs the caller's live-activity signal
 * (`lastTurnEnded`) instead.
 *
 * The start of the stream is itself a turn start. An embedded/system-prompted
 * session opens with an `is-meta` prompt envelope and may never carry a
 * non-meta user message at all — without this, that whole session's files would
 * belong to no turn and silently vanish.
 *
 * @param groups  every group, unfiltered — the trace must see the dense groups
 *                even when the transcript is hiding them.
 * @param visible parallel to `groups`: is this group rendered?
 */
export function planTurnFiles(
  groups: readonly TurnGroup[],
  visible: readonly boolean[],
  opts: { lastTurnEnded: boolean },
): TurnFilesPlan {
  const byRow = new Map<number, TurnFile[]>();
  let files = new Map<string, TurnFile>();
  // The current turn's last rendered row, and the last rendered row overall —
  // the fallback for a turn that rendered nothing of its own.
  let turnRow = -1;
  let lastRow = -1;
  let rowCount = 0;

  const flush = (ended: boolean): void => {
    if (ended && files.size > 0) {
      const at = turnRow >= 0 ? turnRow : lastRow;
      const bucket = byRow.get(at);
      if (bucket) {
        // Two turns can land on one row only when a whole turn rendered
        // nothing; merge under the same create-wins rule rather than clobber.
        const merged = new Map(bucket.map((f) => [f.path, f]));
        collect(merged, files.values());
        byRow.set(at, [...merged.values()]);
      } else {
        byRow.set(at, [...files.values()]);
      }
    }
    files = new Map();
    turnRow = -1;
  };

  for (let i = 0; i < groups.length; i++) {
    // A new user message means the PREVIOUS turn is over — its files are final.
    if (isTurnStart(groups[i])) flush(true);
    collect(files, filesInGroup(groups[i]));
    if (visible[i]) {
      turnRow = rowCount;
      lastRow = rowCount;
      rowCount++;
    }
  }
  flush(opts.lastTurnEnded);

  return { byRow };
}

/** Split a row's files into the two groups the chip row renders. */
export function partitionByChange(files: readonly TurnFile[]): {
  created: readonly TurnFile[];
  edited: readonly TurnFile[];
} {
  return {
    created: files.filter((f) => f.change === 'create'),
    edited: files.filter((f) => f.change === 'edit'),
  };
}
