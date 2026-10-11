import { instancePreferences, PrefKey } from '@sdk';
import type { ViewMode } from '@src/contexts/view-mode-context';
import type { OpenerId } from './tab_opener_types';

/**
 * The ONE writer of "what the user launched last": its opener AND its shape
 * (the view mode the session was born in, or null when the launch has no
 * shape — a terminal, history, a non-chat worker launch). The tab strip's
 * quick-launch slot reads both so "another like the last one" reproduces a
 * Vibe as a Vibe and a terminal as a terminal.
 *
 * Imperative (not a hook) so the launch chains themselves can record at the
 * point the session is created, whatever surface clicked. Every other
 * remember-* helper routes through here, so the two keys never drift apart.
 */
export function rememberLaunch(opener: OpenerId, mode: ViewMode | null): void {
  instancePreferences.set(PrefKey.LAST_OPENER, opener);
  instancePreferences.set(PrefKey.LAST_OPENER_MODE, mode);
}
