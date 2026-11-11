import { isNewerVersion } from '@src/components/version-popover/desktop-update-action';
import type { UpdateReadyState } from '@src/components/update-ready/update-ready';

/**
 * The release the version popover's "Upgrade to vX" names — and installs. On the desktop it is the newest release
 * THIS desktop runs (`desktopTarget`, from the desktop: PyPI's newest may need a newer desktop), or nothing when no
 * newer release runs here (`false`); while the desktop cannot tell (`null` / not asked yet) PyPI's newest is
 * offered, and the desktop checks it before touching the running engine. A browser tab offers PyPI's newest (the
 * backend's install refuses one the desktop cannot run).
 * Nothing either while an update is already downloaded and ready (`updateReady`): it is installed from the popover's
 * "Update ready", and the desktop quietly swaps a newer release into it — never two engine updates side by side.
 */
export function upgradeOfferVersion({
  desktop,
  desktopTarget,
  pypiLatest,
  updateReady = false,
}: {
  desktop: boolean;
  desktopTarget: string | false | null | undefined;
  pypiLatest: string | null | undefined;
  updateReady?: boolean;
}): string | null {
  if (updateReady) return null;
  if (!desktop) return pypiLatest ?? null;
  if (desktopTarget === false) return null;
  return desktopTarget ?? pypiLatest ?? null;
}

/**
 * The engine update waiting to be installed is older than PyPI's newest: the popover asks the desktop to look now
 * (the quiet check the 20-minute pass runs) instead of showing an older ready release beside a newer one for up to
 * 20 minutes. Only an engine-only update — a desktop update decides its own engine.
 */
export function waitingEngineBehindPypi(
  ready: UpdateReadyState | null | undefined,
  pypiLatest: string | null | undefined,
): boolean {
  if (!ready?.ready || ready.restart || !ready.engine) return false;
  return isNewerVersion(ready.engine.to, pypiLatest);
}
