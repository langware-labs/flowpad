/**
 * The tab switch in flight, for the `tab_switch` toplog trail.
 *
 * State only: a switch starts in `openDock` / back / forward / popstate, and every
 * later `tab_switch` log point (loader, commit, paint, ready, error) stamps its line
 * with `sw=<id>` and the ms since that start, so one switch reads as one group of
 * lines. Nothing here logs or aggregates — the call sites are plain `toplog.log`.
 */
export const tabSwitch = {
  /** 0 until the first switch of the page. */
  id: 0,
  t0: 0,
  /** `viewType:pointer` of the target. */
  to: '',
  /** The switch already wrote its `ready` line (one per switch). */
  readyLogged: false,
  /** goBack/goForward already wrote `start`; the popstate it causes is the same switch. */
  awaitingPopstate: false,
};

export function beginTabSwitch(to: string): number {
  tabSwitch.id += 1;
  tabSwitch.t0 = performance.now();
  tabSwitch.to = to;
  tabSwitch.readyLogged = false;
  return tabSwitch.id;
}

/** `sw=<id> +<ms>ms` — the prefix every `tab_switch` line after `start` carries. */
export function sinceTabSwitch(): string {
  return `sw=${tabSwitch.id} +${Math.round(performance.now() - tabSwitch.t0)}ms`;
}
