/**
 * Capabilities the app lends to fence renderers.
 *
 * A renderer runs inside a plain ProseMirror NodeView — no React tree, so no
 * hooks and no context. Anything it needs from the app (navigation, where
 * projects live) has to be handed in. This is that seam, carried on a Milkdown
 * `$ctx` slice the same way `prismConfig` carries its own configuration, and
 * read at render time so the values stay live rather than frozen at mount.
 *
 * Deliberately app-primitives, not renderer concepts: "open a file", "where is
 * this project" — nothing here knows what an interface block is.
 */

import { $ctx } from '@milkdown/utils';

export interface FenceHostServices {
  /**
   * Open a file in the appropriate editor, optionally at a line.
   *
   * `path` is an ABSOLUTE MACHINE path. The host converts it to whatever the
   * dock layer addresses files with, so renderers never deal in VFS paths or
   * compute nodes.
   */
  openFile(path: string, options?: { line?: number }): void;
  /** Root path of the project the current document belongs to, if any. */
  documentProjectRoot(): string | null;
  /** Root path of a project by id, or null when it isn't available locally. */
  projectRootById(projectId: string): string | null;
}

/**
 * Inert defaults, so an editor that never configures the slice still renders —
 * blocks simply report that they cannot resolve or navigate.
 */
export const NO_HOST_SERVICES: FenceHostServices = {
  openFile: () => {},
  documentProjectRoot: () => null,
  projectRootById: () => null,
};

export const fenceHostServicesCtx = $ctx<FenceHostServices, 'fenceHostServices'>(
  NO_HOST_SERVICES,
  'fenceHostServices',
);
