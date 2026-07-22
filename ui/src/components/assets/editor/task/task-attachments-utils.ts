import { gitOriginRepoFullName, type GitOrigin } from '@sdk';
import { gitOriginKey } from '@src/utils/gitUtils';

/**
 * A task attachment (an entry of `task.artifacts`). Pure data + helpers, split
 * out of `TaskAttachments.tsx` so the identity/normalization logic is unit
 * testable without the React component.
 *
 * A GIT attachment is identified by its machine-independent `git_origin`; its
 * (sender-local) `path` is NOT stored — every machine resolves its own checkout
 * from the origin, and `rel` locates the exact subfolder within that checkout.
 * A NON-git attachment keeps its local `path` as identity.
 */
export interface Attachment {
  path?: string;
  label: string;
  git_origin?: GitOrigin;
  rel?: string;
  /** Filename inside the TASK's own entity storage. The machine-independent
   *  identity for a file attachment: the bytes live on the task, so every
   *  member resolves it locally (filling from the hub on a first miss) instead
   *  of chasing the sender's `path`, which means nothing on their disk. */
  vfs?: string;
}

/** Machine-independent key for an entry: the git identity for a git attachment
 *  (so the sender's path never leaks into keys/dedup/install-tracking), else the
 *  local path. */
export function attachmentKey(a: Attachment): string {
  return (a.git_origin && gitOriginKey(a.git_origin)) || a.vfs || a.path || a.label;
}

/** task.artifacts entries are `string | {path?, label, git_origin?, rel?}` —
 *  normalize for display. A git entry is identified by `git_origin`, so its
 *  (per-machine, sender-local) `path` is dropped here and never used across
 *  machines; a non-git entry keeps its `path` as identity. */
export function normalizeAttachments(artifacts: unknown): Attachment[] {
  if (!Array.isArray(artifacts)) return [];
  const out: Attachment[] = [];
  for (const a of artifacts) {
    if (typeof a === 'string' && a) {
      out.push({ path: a, label: a.split('/').pop() || a });
    } else if (a && typeof a === 'object') {
      const git = (a.git_origin as GitOrigin | undefined) || undefined;
      const path = typeof a.path === 'string' ? a.path : undefined;
      const vfs = typeof a.vfs === 'string' && a.vfs ? a.vfs : undefined;
      if (!path && !git && !vfs) continue; // an entry needs at least one identity
      const label =
        a.label ||
        vfs ||
        (path ? path.split('/').pop() : undefined) ||
        (git ? gitOriginRepoFullName(git) : undefined) ||
        'attachment';
      out.push({
        label,
        // Drop the sender-local path for git entries (identity is git_origin).
        ...(git ? { git_origin: git } : path ? { path } : {}),
        ...(git && typeof a.rel === 'string' ? { rel: a.rel } : {}),
        // Bytes stored on the task itself — resolves on every member's machine.
        ...(!git && typeof a.vfs === 'string' && a.vfs ? { vfs: a.vfs } : {}),
      });
    }
  }
  return out;
}

/** Build the stored entry for a freshly added path. A git folder becomes
 *  `{label, git_origin, rel}` (no sender path — `rel` is the offset within its
 *  git context folder root, machine-independent); anything else keeps `{path,
 *  label}`. */
export function makeAttachmentEntry(
  p: string,
  gitOrigin: GitOrigin | undefined,
  contextDirPath: string | null,
): Attachment {
  const label = p.split('/').pop() || p;
  if (gitOrigin) {
    const rel = contextDirPath ? p.slice(contextDirPath.length).replace(/^\/+/, '') : '';
    return { label, git_origin: gitOrigin, ...(rel ? { rel } : {}) };
  }
  return { path: p, label };
}
