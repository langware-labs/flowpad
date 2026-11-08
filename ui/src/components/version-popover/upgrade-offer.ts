/**
 * The release the version popover's "Upgrade to vX" names — and installs. On the desktop it is the newest release
 * THIS desktop runs (`desktopTarget`, from the desktop: PyPI's newest may need a newer desktop), or nothing when no
 * newer release runs here (`false`); while the desktop cannot tell (`null` / not asked yet) PyPI's newest is
 * offered, and the desktop checks it before touching the running engine. A browser tab offers PyPI's newest (the
 * backend's install refuses one the desktop cannot run).
 */
export function upgradeOfferVersion({
  desktop,
  desktopTarget,
  pypiLatest,
}: {
  desktop: boolean;
  desktopTarget: string | false | null | undefined;
  pypiLatest: string | null | undefined;
}): string | null {
  if (!desktop) return pypiLatest ?? null;
  if (desktopTarget === false) return null;
  return desktopTarget ?? pypiLatest ?? null;
}
