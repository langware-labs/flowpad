import { isAbsoluteMachinePath, TypeId, VFSPath } from '@sdk';

/**
 * Turn a transcript's raw file path into the VFS path a dock pointer can
 * address — or null when it cannot be resolved.
 *
 * This conversion is NOT optional and NOT already done for us. A
 * `FileWriteEntry.path` is whatever the vendor wrote:
 *
 *   - Claude `Write` → an ABSOLUTE machine path (`/tmp/x.md`, `C:\Users\…\x.ts`)
 *   - Codex `apply_patch *** Add File` → a cwd-RELATIVE path (`docs/hello.md`)
 *
 * Handing either straight to `navigation.openFile` (as the `{kind:'vfs', path}`
 * chip target does) only appears to work: the asset editors normalize a machine
 * path on the way in, but `DockPointer.forFile` does not, so a CODE file
 * resolves against the ambient project root and 404s. Converting up front is
 * what makes the chip open the file the agent actually wrote.
 *
 * Pure and React-free so the Windows/POSIX × absolute/relative matrix is
 * unit-testable without a DOM.
 */
export function turnFileVfsPath(
  rawPath: string,
  ctx: { workdir?: string | null; locator: TypeId },
): string | null {
  if (!rawPath) return null;

  try {
    if (isAbsoluteMachinePath(rawPath)) {
      return VFSPath.fromMachinePath(rawPath, ctx.locator).rawPath;
    }

    // Relative — only the process's own workdir can anchor it.
    const relative = rawPath.replace(/^\.[\\/]+/, '').replace(/^[\\/]+/, '');
    const workdir = ctx.workdir?.trim();
    if (!relative || !workdir) return null;

    // The workdir may already be VFS-shaped (`compute_node-@local/repo`), in
    // which case its node wins over the ambient one.
    const base = VFSPath.parse(workdir);
    if (base.isAbsolute && base.typeId) {
      return VFSPath.fromTypeId(base.typeId, joinPosix(base.entitySubPath, relative)).rawPath;
    }

    if (isAbsoluteMachinePath(workdir)) {
      // `fromMachinePath` normalizes the whole string, so a Windows workdir
      // joined with a POSIX-separated relative path is fine.
      return VFSPath.fromMachinePath(`${trimTrailingSeparators(workdir)}/${relative}`, ctx.locator).rawPath;
    }

    return null;
  } catch (err) {
    // `fromMachinePath` throws on anything it can't call absolute. A malformed
    // path must leave the chip inert, never take the transcript down.
    console.warn('[turn-files] could not resolve a touched path', rawPath, err);
    return null;
  }
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function joinPosix(base: string, relative: string): string {
  const left = trimTrailingSeparators(base).replace(/\\/g, '/');
  const right = relative.replace(/\\/g, '/');
  return left ? `${left}/${right}` : right;
}
