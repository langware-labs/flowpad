import { FlowData, FlowElementTypes } from '@sdk';

import type { TurnGroup } from './groupTurnEvents';
import { transcriptEntry } from './transcriptEntry';

/**
 * "Files this turn created" — the trace behind the chat's per-turn chip row.
 *
 * Why this exists: Standard mode ships with "Show tool calls" OFF
 * (`preferences.chat.show_tools`, default false), so a turn that writes files
 * renders as prose with nothing to click. The write is already on the wire —
 * the backend attaches a typed `FileWriteEntry` to every frame, identically on
 * the live stream and on replay — so the chips are a pure read of what the chat
 * already has.
 *
 * Scope is deliberately narrow: a **created** file is a `file_write` entry
 * (Claude `Write`, Codex `apply_patch *** Add File`). An EDIT is not a
 * creation, and a `flow artifact` registration already has its own chip in the
 * bottom ribbon. Note that the backend hardcodes `is_new=True` on every
 * `FileWriteEntry`, so re-writing an existing file also reads as "created"
 * here; the guard below is defensive, not a real did-not-exist test. (The
 * backend's own create/update distinction lives in `AgenticProcess.markdown_docs`,
 * which is markdown-only and process-scoped, so it can't back this.)
 */
export interface CreatedFile {
  /**
   * The path exactly as the transcript entry carried it — ABSOLUTE for Claude
   * `Write`, cwd-RELATIVE for Codex `apply_patch`. Resolving it to something
   * openable is `createdFileVfsPath`'s job, not this module's.
   */
  path: string;
  /** Display label: the basename, split on both separators (Windows paths). */
  name: string;
}

const NO_FILES: readonly CreatedFile[] = Object.freeze([]);

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

/** The path a frame created, or null when the frame didn't create a file. */
function createdPathOf(event: FlowData): string | null {
  if (event.elementType !== FlowElementTypes.TOOL_CALL) return null;
  const entry = transcriptEntry(event);
  if (!entry || entry.kind !== 'file_write') return null;
  // A failed write created nothing; `is_new: false` would mean a plain overwrite.
  if (entry.is_error === true || entry.is_new === false) return null;
  const path = entry.path;
  return typeof path === 'string' && path ? path : null;
}

/**
 * Per-group memo. Committed groups keep their object identity across live
 * appends (`createTurnGrouper`), so a streaming frame costs O(new events)
 * instead of re-scanning the whole history — the same constraint that made the
 * grouper incremental in the first place (QA D10). It also gives the rendered
 * chip row a stable `files` identity to memoize on.
 */
const groupFiles = new WeakMap<TurnGroup, readonly CreatedFile[]>();

/**
 * Files created by one group, deduped by path, in first-seen order.
 *
 * Reads `group.events`, NOT the raw item stream, on purpose: the grouper
 * RETRACTS a row when a refinement of it arrives (`createTurnGrouper`'s
 * `retract` — a `shell_command → flow_command → artifact` chain collapses to
 * its leaf). Tracing the group inherits that suppression for free, so the chips
 * can never surface a write the chat itself decided not to render.
 */
export function createdFilesInGroup(group: TurnGroup): readonly CreatedFile[] {
  if (group.kind !== 'dense') return NO_FILES;
  const cached = groupFiles.get(group);
  if (cached) return cached;

  const files: CreatedFile[] = [];
  const seen = new Set<string>();
  for (const event of group.events) {
    const path = createdPathOf(event);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push({ path, name: fileNameOf(path) });
  }

  const result = files.length > 0 ? Object.freeze(files) : NO_FILES;
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

export interface TurnCreatedFilesPlan {
  /**
   * Visible-row index → the files to render after that row. The key is an index
   * into the RENDERED sequence, not into `groups`, because the caller filters
   * dense groups out when "Show tool calls" is off — and that is exactly the
   * case this feature exists for. `-1` means "before the first rendered row"
   * (a turn whose every group was filtered out).
   */
  readonly byRow: ReadonlyMap<number, readonly CreatedFile[]>;
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
export function planTurnCreatedFiles(
  groups: readonly TurnGroup[],
  visible: readonly boolean[],
  opts: { lastTurnEnded: boolean },
): TurnCreatedFilesPlan {
  const byRow = new Map<number, CreatedFile[]>();
  let files: CreatedFile[] = [];
  let seen = new Set<string>();
  // The current turn's last rendered row, and the last rendered row overall —
  // the fallback for a turn that rendered nothing of its own.
  let turnRow = -1;
  let lastRow = -1;
  let rowCount = 0;

  const flush = (ended: boolean): void => {
    if (ended && files.length > 0) {
      const at = turnRow >= 0 ? turnRow : lastRow;
      const bucket = byRow.get(at);
      if (bucket) {
        // Two turns can land on one row only when a whole turn rendered nothing;
        // merge rather than clobber, and keep the row free of duplicates.
        const have = new Set(bucket.map((f) => f.path));
        for (const f of files) if (!have.has(f.path)) bucket.push(f);
      } else {
        byRow.set(at, files);
      }
    }
    files = [];
    seen = new Set();
    turnRow = -1;
  };

  for (let i = 0; i < groups.length; i++) {
    // A new user message means the PREVIOUS turn is over — its files are final.
    if (isTurnStart(groups[i])) flush(true);
    for (const file of createdFilesInGroup(groups[i])) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      files.push(file);
    }
    if (visible[i]) {
      turnRow = rowCount;
      lastRow = rowCount;
      rowCount++;
    }
  }
  flush(opts.lastTurnEnded);

  return { byRow };
}
