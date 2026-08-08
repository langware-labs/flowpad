import { DockPointer } from './DockPointer';

/**
 * Parse a URL into a pointer, or null when it is not a dock URL.
 *
 * `DockPointer.fromUrl` throws on a path it cannot make sense of, which is the
 * right behaviour for code that has a pointer and expects one. The
 * canonicalizers run over EVERY incoming URL — most of which are already
 * canonical, or are not docks at all — so for them "not a dock" is an ordinary
 * answer rather than an exception.
 *
 * Shared so the three canonicalizers cannot drift on what "not a dock" means.
 */
export function tryParseDock(url: string): DockPointer | null {
  try {
    const dock = DockPointer.fromUrl(url);
    return dock.viewType ? dock : null;
  } catch {
    return null;
  }
}
