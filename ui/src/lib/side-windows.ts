/**
 * Dock-URL round-trip for "which side windows are open + which one is active".
 *
 * This is the ONE place that knows the `sideWindows` / `activeSideWindow`
 * option-key grammar in a dock URL; every dock goes through
 * `DockPointer.sideWindows` / `DockPointer.withSideWindows`, which delegate
 * here — no surface constructs or parses those keys itself. Mirrors the
 * `scopeFilter` pattern in `lib/scope-filter.ts` (getter + builder + serde).
 *
 * Ids are OPAQUE, view-specific strings (terminal `SideTabId`, markdown
 * `chat`/`backlinks`/`runs`/`revisions`, …). A session dock and an asset dock
 * never share a URL, so one field serves every surface. This layer neither
 * knows nor validates the id vocabulary; the consuming surface maps the id
 * list onto its own registry and drops any id it doesn't recognize.
 */
export interface SideWindowsState {
  /** Ordered, de-duplicated list of open side-window ids. */
  windows: string[];
  /** Active window id, or null to default to the last in `windows`. */
  active: string | null;
}

export const SIDE_WINDOWS_PARAM = 'sideWindows';
export const ACTIVE_SIDE_WINDOW_PARAM = 'activeSideWindow';

const SIDE_WINDOW_OPTION_KEYS = [SIDE_WINDOWS_PARAM, ACTIVE_SIDE_WINDOW_PARAM] as const;

/** Split a CSV of ids into an ordered, de-duplicated, trimmed list. */
export function parseSideWindowList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  const seen = new Set<string>();
  for (const piece of csv.split(',')) {
    const id = piece.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

/**
 * Serialize the state onto dock options. The active id is only stamped when it
 * differs from the natural last-in-list default, keeping URLs clean for the
 * common single/last-active case.
 */
export function sideWindowsToDockOptions(state: SideWindowsState): Record<string, string> {
  const opts: Record<string, string> = {};
  if (state.windows.length > 0) opts[SIDE_WINDOWS_PARAM] = state.windows.join(',');
  const defaultActive = state.windows[state.windows.length - 1] ?? null;
  if (state.active && state.active !== defaultActive && state.windows.includes(state.active)) {
    opts[ACTIVE_SIDE_WINDOW_PARAM] = state.active;
  }
  return opts;
}

/**
 * Merge `state` into existing dock options, REPLACING any prior side-window
 * keys so a stale `sideWindows`/`activeSideWindow` can't linger. Non-side-window
 * options pass through untouched. The single mutator used by
 * `DockPointer.withSideWindows`.
 */
export function withSideWindowsOptions(
  options: Record<string, string> | undefined,
  state: SideWindowsState,
): Record<string, string> {
  const next: Record<string, string> = { ...options };
  for (const k of SIDE_WINDOW_OPTION_KEYS) delete next[k];
  return { ...next, ...sideWindowsToDockOptions(state) };
}

/**
 * Parse dock options back into a `SideWindowsState`, or null when no
 * side-window keys are present (so callers treat it as "nothing open").
 */
export function dockOptionsToSideWindows(
  options: Record<string, string> | undefined,
): SideWindowsState | null {
  if (!options || !SIDE_WINDOW_OPTION_KEYS.some((k) => k in options)) return null;
  const windows = parseSideWindowList(options[SIDE_WINDOWS_PARAM]);
  const activeRaw = options[ACTIVE_SIDE_WINDOW_PARAM];
  const active = activeRaw && windows.includes(activeRaw) ? activeRaw : null;
  return { windows, active };
}
