import type { AssetDescriptor, AssetSource } from '@sdk';

/**
 * Where an asset on the Assets board comes from, at the grain the board's
 * header toggles filter by. Coarser than `assetScope` (which names the exact
 * folder/project for the row chip): a toggle answers "show me everything from
 * the user's home", not "from this one folder".
 */
export type BoardScope = 'project' | 'dirs' | 'user' | 'assistant' | 'worker';

/** Toggle order in the header. */
export const BOARD_SCOPES: readonly BoardScope[] = ['project', 'dirs', 'user', 'assistant', 'worker'];

/** What a fresh viewer sees: the run's own world, not everything it could reach. */
export const DEFAULT_SHOWN_SCOPES: readonly BoardScope[] = ['project', 'dirs'];

const SCOPE_BY_SOURCE: Record<AssetSource, BoardScope> = {
  project_dir: 'project',
  workdir: 'project',
  // The run's own (embedded / agent-inline) assets belong with its project.
  embedded: 'project',
  inline: 'project',
  additional_dir: 'dirs',
  context_dir: 'dirs',
  user_dir: 'user',
  // Only present when the Flowpad Assistant is mounted into the worker.
  system: 'assistant',
  // Path-backed extras the worker itself reported (plugins, harness-bundled).
  external: 'worker',
};

export function assetBoardScope(descriptor: Pick<AssetDescriptor, 'source'>): BoardScope {
  // An unknown source from a newer backend lands with the worker's extras rather
  // than vanishing — the same fail-soft stance as `assetSourceLabel`.
  return SCOPE_BY_SOURCE[descriptor.source] ?? 'worker';
}

const STORAGE_KEY = 'flowpad.assetManager.scopes';

/** The viewer's last toggle choice; the default when absent or unreadable. */
export function loadShownScopes(): Set<BoardScope> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((s): s is BoardScope => BOARD_SCOPES.includes(s as BoardScope)));
      }
    }
  } catch {
    // private mode / blocked storage / corrupt value — fall through to the default
  }
  return new Set(DEFAULT_SHOWN_SCOPES);
}

export function saveShownScopes(shown: ReadonlySet<BoardScope>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...shown]));
  } catch {
    // a per-viewer convenience; losing it is harmless
  }
}
