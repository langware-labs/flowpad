/**
 * The tab switch in flight, for the `tab_switch` toplog trail.
 *
 * State only: a switch starts in `openDock` / a detached commit / a real popstate,
 * and every later `tab_switch` log point (loader, commit, paint, ready, error)
 * stamps its line with `sw=<id>` and the ms since that start, so one switch reads
 * as one group of lines. Nothing here logs or aggregates — the call sites are
 * plain `toplog.log`.
 */
export const tabSwitch = {
  /** 0 until the first switch of the page (the page load itself is `sw=0`). */
  id: 0,
  t0: 0,
  /** The switch already wrote its `ready` line (one per switch). */
  readyLogged: false,
};

export function beginTabSwitch(): number {
  tabSwitch.id += 1;
  tabSwitch.t0 = performance.now();
  tabSwitch.readyLogged = false;
  return tabSwitch.id;
}

/** `sw=<id> +<ms>ms` — the prefix every `tab_switch` line after `start` carries. */
export function sinceTabSwitch(): string {
  return `sw=${tabSwitch.id} +${Math.round(performance.now() - tabSwitch.t0)}ms`;
}

/** First caller per switch wins the `ready` line; every later one gets false. */
export function claimTabSwitchReady(): boolean {
  if (tabSwitch.readyLogged) return false;
  tabSwitch.readyLogged = true;
  return true;
}

/** `viewType:pointer` — the one spelling of a dock in the `navigation` and `tab_switch` trails. */
export function dockLabel(d: { viewType?: string | null; pointer?: string | null } | null): string | null {
  return d ? `${d.viewType}:${d.pointer ?? ''}` : null;
}
