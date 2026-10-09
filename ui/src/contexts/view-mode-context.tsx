import {
  AgenticProcess,
  dataContext,
  type IDockPointer,
  instancePreferences,
  onPreferenceChange,
  PREF_REGISTRY,
  PrefKey,
  TypeId,
  ViewModeEvent,
  viewModeMemory,
} from '@sdk';
import { usePreferenceValue } from '@src/hooks/use-preference';
import { defineGlobal } from '@sdk/utils';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { useCurrentDock } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

declare global {
  interface Window {
    setView: (val: ViewMode) => void;
    getView: () => ViewMode;
    setDev: (val?: boolean) => void;
    getDev: () => boolean;
  }
}

/**
 * A view mode is a session SURFACE — read with `surfaceForViewMode` (vibe
 * workspace / chat pane / xterm) — stated by each tab's own URL. The chrome
 * TIER is no longer part of it: power-user chrome (`AdvancedOnly`, `DevOnly`,
 * `useIsAdvanced`) follows the developer-mode SWITCH (`useIsDev`), on any surface.
 * `Dev` stays in the enum only for addresses and stored values written while it
 * was a mode.
 */
export enum ViewMode {
  // Hierarchy (simplest → fullest): Vibe ⊂ Standard ⊂ Advanced ⊂ Dev.
  Vibe = 'vibe',
  Standard = 'standard',
  Advanced = 'advanced',
  Dev = 'dev',
}

// The stored `preferences.ui.view_mode` is kept as state (the session switch still
// writes it, and view-mode memory reads it), but NO UI decides anything from it:
// an address that states no mode shows `UNSTATED_VIEW_MODE`. The mode on screen is
// reflected as a `data-view` attribute on the document root so CSS can react.

// Strict validator: unknown/garbage reads as *unset* (null). Used directly for
// values adopted from a Project's stored `last_mode`, where a default fallback
// would silently launder bad data into a remembered preference.
function toViewModeOrNull(v: unknown): ViewMode | null {
  return v === ViewMode.Standard || v === ViewMode.Advanced || v === ViewMode.Dev || v === ViewMode.Vibe
    ? (v as ViewMode)
    : null;
}

function toViewMode(v: unknown): ViewMode {
  return toViewModeOrNull(v) ?? toViewModeOrNull(PREF_REGISTRY[PrefKey.VIEW_MODE].defaultValue) ?? ViewMode.Standard;
}

/**
 * The "advanced-or-fuller" threshold from the mode hierarchy (Advanced ⊂ Dev),
 * as a plain predicate so both the `useIsAdvanced` hook and non-hook callers
 * (e.g. syncDesktopMenu) share one definition of where "advanced" begins.
 */
export function isAdvancedMode(mode: ViewMode): boolean {
  return mode === ViewMode.Advanced || mode === ViewMode.Dev;
}

/**
 * The SURFACE a view mode shows an agent session in — the single mapping that
 * makes View mode the one mode selector. Vibe is the vibe workspace, Standard is
 * the chat pane, Advanced/Dev is the raw terminal.
 *
 * This used to be a second preference (`chat mode`), which could and did drift
 * out of sync with View mode — both carried a `vibe` and each control wrote only
 * its own. One enum, one preference, one control.
 */
export type SessionSurface = 'vibe' | 'chat' | 'terminal';

export function surfaceForViewMode(mode: ViewMode): SessionSurface {
  if (mode === ViewMode.Vibe) return 'vibe';
  return isAdvancedMode(mode) ? 'terminal' : 'chat';
}

/** Transport for a mode: only the terminal surface runs an interactive PTY. */
export function viewModePtyMode(mode: ViewMode): boolean {
  return surfaceForViewMode(mode) === 'terminal';
}

/**
 * Reactive session surface. Always known: it follows the tab's stated mode (its
 * URL) or the app's one mode, never the stored preference — so there is no
 * first-paint wait for `preferences.json` (which there used to be, while the
 * preference decided it).
 */
export function useSessionSurface(): SessionSurface {
  return surfaceForViewMode(useViewMode());
}

const viewModeOverrideListeners = new Set<() => void>();
// The mode a viewMode-carrying dock URL displays. Loading such a URL does NOT
// save it into the persisted preference — only a switch does
// (useDockViewModeOverrideSync) — so this can differ from the pref, and anything
// that acts on "the current mode" must read getEffectiveViewMode(), not the pref.
let dockViewModeOverride: ViewMode | null = null;
let flickerTimer: number | undefined;

function subscribeViewModeOverride(listener: () => void): () => void {
  viewModeOverrideListeners.add(listener);
  return () => viewModeOverrideListeners.delete(listener);
}

function getViewModeOverrideSnapshot(): ViewMode | null {
  return dockViewModeOverride;
}

/**
 * The mode a surface shows when nothing STATES one. The stored `view_mode`
 * preference is kept (URLs still carry `?viewMode`, the session switch still
 * writes it) but no UI decides anything from it any more: everything is a tab,
 * a tab states its own surface in its URL, and an address that states none is
 * the app's one mode — Vibe.
 */
export const UNSTATED_VIEW_MODE = ViewMode.Vibe;

/**
 * The active mode for non-React callers — the same value `useViewMode()`
 * resolves to, without the hook: the mounted dock's stated mode, else
 * {@link UNSTATED_VIEW_MODE}. Never the stored preference.
 */
export function getEffectiveViewMode(): ViewMode {
  return dockViewModeOverride ?? UNSTATED_VIEW_MODE;
}

// Vibe's display font (Plus Jakarta Sans) is injected only when Vibe is actually
// active, so Standard/Advanced/Dev users never fetch it. NOTE: Vibe is now the
// default mode, so the common path DOES take this on boot — `applyAttribute` runs
// at module load below, and a <link rel="stylesheet"> in <head> is render-blocking
// on a cross-origin round-trip. Self-hosting or preconnecting the font would get
// that off first paint; lazy injection alone no longer buys what it used to.
let vibeFontInjected = false;
function ensureVibeFont(): void {
  if (vibeFontInjected || typeof document === 'undefined') return;
  vibeFontInjected = true;
  const link = document.createElement('link');
  link.id = 'vibe-font';
  link.rel = 'stylesheet';
  link.href =
    'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap';
  document.head.appendChild(link);
}

// Mirror the effective view mode to the Electron application menu: it is shown
// only in Advanced/Dev (see electron/main.js `set-menu-visible`). A no-op in the
// browser build (no electronAPI). Keyed on the advanced boolean, not the exact
// mode, so Advanced↔Dev and Vibe↔Standard transitions don't re-send.
let lastMenuVisibleSent: boolean | null = null;
function syncDesktopMenu(val: ViewMode): void {
  const visible = isAdvancedMode(val) || getDev();
  if (visible === lastMenuVisibleSent) return;
  const setMenuVisible = (
    window as unknown as {
      electronAPI?: { setMenuVisible?: (visible: boolean) => void };
    }
  ).electronAPI?.setMenuVisible;
  if (typeof setMenuVisible !== 'function') return;
  lastMenuVisibleSent = visible;
  setMenuVisible(visible);
}

function applyAttribute(val: ViewMode, animate = true): void {
  if (val === ViewMode.Vibe) ensureVibeFont();
  syncDesktopMenu(val);
  const root = document.documentElement;
  const prev = root.getAttribute('data-view');
  // Guard: prefMan fires on EVERY pref change, but only a view-mode change need
  // touch the DOM. Skip the write when the attribute already matches.
  if (prev !== val) {
    root.setAttribute('data-view', val);
    if (animate && prev != null) {
      root.classList.remove('view-mode-glow-flicker');
      // Restart the CSS animation even when changes happen in quick succession.
      void root.offsetWidth;
      root.classList.add('view-mode-glow-flicker');
      if (flickerTimer !== undefined) window.clearTimeout(flickerTimer);
      // Hold the element, not the `document` global: this timer can outlive the
      // document (a jsdom test environment is torn down between files), and
      // dereferencing the global afterwards throws `document is not defined`,
      // which vitest reports as an unhandled error and fails an otherwise green run.
      flickerTimer = window.setTimeout(() => {
        root.classList.remove('view-mode-glow-flicker');
        flickerTimer = undefined;
      }, 700);
    }
  }
}

function setDockViewModeOverride(val: ViewMode | null, animate = true): void {
  if (dockViewModeOverride === val) {
    applyAttribute(getEffectiveViewMode(), false);
    return;
  }
  dockViewModeOverride = val;
  applyAttribute(getEffectiveViewMode(), animate);
  viewModeOverrideListeners.forEach((listener) => listener());
}

// One-time carry of the oldest encoding, a `devMode` localStorage boolean, onto
// the Dev switch (it went through viewMode=dev while Dev was a mode).
if (typeof localStorage !== 'undefined' && localStorage.getItem('devMode') === 'true') {
  localStorage.removeItem('devMode');
  instancePreferences.set(PrefKey.DEV_MODE, true);
}

export function getViewMode(): ViewMode {
  return toViewMode(instancePreferences.get(PrefKey.VIEW_MODE));
}

// View-mode MEMORY (`last_mode` on a session or project) is read here and in
// navigation, and written ONLY through the SDK's `viewModeMemory`, whose
// `VIEW_MODE_STORE` policy decides which events mint it. Restoring a mode never
// writes: a remembered mode reaches the screen by being stated on the URL.

/** A target's remembered mode, or null when it has none (or garbage). */
export function rememberedViewMode(target: { last_mode?: string | null } | null | undefined): ViewMode | null {
  return toViewModeOrNull(target?.last_mode ?? null);
}

/**
 * The id of the session a dock addresses, or null when it addresses something
 * else. A session is shown at `/dock/shell/agentic_process-<id>` or as the Vibe
 * host tab `/dock/vibe/agentic_process-<id>` (`DockPointer.isSessionView`), so this
 * is the whole grammar.
 */
export function sessionIdForDock(dock: IDockPointer): string | null {
  if (!DockPointer.isSessionView(dock.viewType) || !dock.pointer) return null;
  const prefix = AgenticProcess.type + TypeId.DELIMITER;
  return dock.pointer.startsWith(prefix) ? dock.pointer.slice(prefix.length) : null;
}

/**
 * The mode a dock should open in from its own memory — the cache-only read
 * behind the URL-first seed in `NavigationActions.openDock`. The memory lives on
 * the dock's TARGET (the same entity its tab is minted against), when that
 * target's type carries `last_mode`. Null when it has none, it is not in cache
 * (a cold deep link: the shell loader redirects onto the remembered mode), or
 * it has never stored a mode.
 */
export function rememberedDockViewMode(dock: IDockPointer): ViewMode | null {
  return rememberedViewMode(viewModeMemory.targetFor(dock.targetTypeId));
}

// The last mode that wasn't Vibe. Entering Vibe ADOPTS it as the persisted
// preference (useDockViewModeOverrideSync), which overwrites whatever the user
// had — so without this latch, an "exit vibe" affordance has nothing to return
// to and an Advanced (or revealed Dev) user who visits Vibe and leaves lands on
// Standard. The footer selector can still reach Terminal by hand; this latch is
// what makes the automatic way back land where the user came from.
// Module-scope, session-lived, deliberately not persisted.
let lastNonVibeViewMode: ViewMode | null = null;

function recordNonVibe(val: ViewMode): void {
  if (val !== ViewMode.Vibe) lastNonVibeViewMode = val;
}
recordNonVibe(getViewMode());

/** Where an "exit vibe" affordance should land: the mode in use before Vibe. */
export function previousNonVibeViewMode(): ViewMode {
  return lastNonVibeViewMode ?? ViewMode.Standard;
}

/**
 * THE mode switch: persist `val` as the preference and report `ModeSwitch` to
 * view-mode memory, against `dock`'s memory target (when the switch happened on
 * a dock) and the current project. Every path that changes mode on purpose —
 * the footer toggle's navigation (via `useDockViewModeOverrideSync`), a
 * pointerless toggle, `window.setView` / `setDev` — lands here, and nothing that
 * merely opens or restores a tab does.
 */
export function setViewMode(val: ViewMode, dock: IDockPointer | null = null): void {
  recordNonVibe(val);
  instancePreferences.set(PrefKey.VIEW_MODE, val);
  applyAttribute(getEffectiveViewMode());
  viewModeMemory.record(
    ViewModeEvent.ModeSwitch,
    { tab: viewModeMemory.targetFor(dock?.targetTypeId), project: dataContext.project },
    val,
  );
}

/**
 * The `?viewMode=` carried by the address being loaded, if it names a real mode.
 *
 * URL-first (CLAUDE.md, non-negotiable): the address is authoritative for what is
 * shown, so it must win from the FIRST paint, not after a repaint. Import-time
 * paint used to read ONLY the persisted preference, so `/?viewMode=vibe` painted
 * `data-view="standard"`; the attribute was corrected later only if a
 * preference-CHANGE event happened to fire, and when the stored value is already
 * resolved at boot no such event ever comes, so the URL simply lost.
 * (`getEffectiveViewMode()` cannot close this: its `dockViewModeOverride` is still
 * null at module import — `useDockViewModeOverrideSync` populates it once the dock
 * mounts.) Reading the param here fixes the ordering at its source; it is not a
 * wait, a retry, or a timing budget.
 *
 * Strict by construction: `toViewModeOrNull` returns null for anything that is not
 * a real mode, so a junk param falls through to `UNSTATED_VIEW_MODE`.
 */
function viewModeFromLocation(): ViewMode | null {
  try {
    // The address states the mode — an option, or implied by a Vibe host dock
    // (`DockPointer.viewMode`). A non-dock path has none.
    return DockPointer.fromUrl(`${window.location.pathname}${window.location.search}`).viewMode;
  } catch {
    return null;
  }
}

// Keep `data-view` in sync with prefMan: on import (first paint) and on every change,
// including a cross-device backend value reconciled in on load. The URL's mode
// outranks the stored preference on that first paint (see viewModeFromLocation).
/**
 * The mode the `data-view` ATTRIBUTE should show right now.
 *
 * Deliberately NOT `getEffectiveViewMode()`: the override is null until the dock
 * mounts, so that would paint `UNSTATED_VIEW_MODE` over the URL's own mode on the
 * first paint. The URL sits between the two: a mounted dock override still wins,
 * otherwise the address decides, and only then the unstated mode.
 *
 * Scoped to the attribute ON PURPOSE. Seeding `dockViewModeOverride` from the
 * URL instead was tried and reverted: that value also feeds `openDock`'s
 * canonicalization, and pinning it there broke pointer routing (dock_sweep went
 * 2 failures -> 8-9, landing on the wrong paths). Painting is presentation;
 * routing is not.
 */
function attributeViewMode(): ViewMode {
  return dockViewModeOverride ?? viewModeFromLocation() ?? UNSTATED_VIEW_MODE;
}

applyAttribute(attributeViewMode(), false);
onPreferenceChange(() => applyAttribute(attributeViewMode()));

defineGlobal('setView', setViewMode);
defineGlobal('getView', getViewMode);

// --- Dev mode: a SWITCH, not a view mode ---
//
// Dev used to be the fourth view mode (Vibe < Standard < Advanced < Dev). That
// made it unreachable where it is needed most: on a session tab the URL's own
// `?viewMode=` wins over the stored mode, so Dev was shadowed on every terminal,
// chat and Vibe tab. It is now its own preference, layered over whichever
// surface is showing. A stored `view_mode = "dev"` — written while Dev was a
// mode — still reads as Dev on, so nobody silently drops out of it; the next
// toggle retires that value (to Advanced, the surface Dev showed).

/** Whether developer mode is on. */
export function getDev(): boolean {
  return isDevOn(instancePreferences.get(PrefKey.DEV_MODE), instancePreferences.get(PrefKey.VIEW_MODE));
}

function isDevOn(devPref: unknown, viewModePref: unknown): boolean {
  return devPref === true || viewModePref === ViewMode.Dev;
}

/** Non-hook {@link useTierMode}. */
export function getTierMode(): ViewMode {
  return getDev() ? ViewMode.Dev : UNSTATED_VIEW_MODE;
}

/** Turn developer mode on/off; no argument toggles. */
export function setDev(val?: boolean): void {
  const next = val ?? !getDev();
  if (getViewMode() === ViewMode.Dev) instancePreferences.set(PrefKey.VIEW_MODE, ViewMode.Advanced);
  instancePreferences.set(PrefKey.DEV_MODE, next);
}

defineGlobal('setDev', setDev);
defineGlobal('getDev', getDev);

export function useViewMode(): ViewMode {
  const currentDock = useCurrentDock();
  const override = useSyncExternalStore(
    subscribeViewModeOverride,
    getViewModeOverrideSnapshot,
    getViewModeOverrideSnapshot,
  );
  // URL-first: a committed dock URL is authoritative immediately; the transient
  // override is a projection adopted by a later effect. An address that states
  // no mode shows the app's one mode — never the stored preference.
  const mode = currentDock?.viewMode ?? override ?? UNSTATED_VIEW_MODE;
  useEffect(() => applyAttribute(mode), [mode]);
  return mode;
}

/** History state a user's mode switch travels with — see `useDockViewModeOverrideSync`. */
export const VIEW_MODE_SWITCH_STATE = { viewModeSwitch: true } as const;

export function isViewModeSwitchState(state: unknown): boolean {
  return (state as { viewModeSwitch?: unknown } | null)?.viewModeSwitch === true;
}

/**
 * Sync the current DockPointer's viewMode override into useViewMode(), and turn
 * a mode SWITCH into `setViewMode`.
 *
 * The footer toggle only navigates (same pointer, `?viewMode=<mode>`), so a
 * switch is read off the URL transition rather than written in the click path:
 * the SAME dock committing with a DIFFERENT mode. Any other load — opening a
 * tab, a seeded or explicit opener mode, a redirect that adds the mode to a bare
 * URL — only displays its mode. That is what keeps memory and the preference
 * from being minted by merely looking at something.
 */
export function useDockViewModeOverrideSync(): void {
  const currentDock = useCurrentDock();
  const override = currentDock?.viewMode ?? null;
  const previous = useRef(currentDock);
  const marked = isViewModeSwitchState(useLocation().state);

  useEffect(() => {
    const prev = previous.current;
    previous.current = currentDock;
    // The glow marks a MODE SWITCH — the same place in another mode. Moving to
    // another tab (a Vibe tab ⇄ a terminal tab) repaints the skin without it.
    // A session's own CHILD (its Vibe workspace showing a document) is the same
    // place too: "Open terminal" switches the session from wherever in it you are.
    const samePlace =
      !!prev &&
      !!currentDock &&
      (prev.withViewMode(null).equals(currentDock.withViewMode(null)) ||
        (!!prev.hostProcessId && prev.hostProcessId === currentDock.pointer));
    setDockViewModeOverride(override, samePlace);
    // A switch is the same dock committing with a different mode. From a bare
    // URL only the toggle's marker makes it one: a redirect that adds the mode
    // carries no marker, so it only displays.
    if (!currentDock || !prev || !override || prev.viewMode === override) return;
    if (!prev.viewMode && !marked) return;
    if (samePlace) setViewMode(override, currentDock);
  }, [currentDock, override, marked]);

  useEffect(() => () => setDockViewModeOverride(null), []);
}

/** Advanced UI == developer mode: the power-user extras show only with Dev on. */
export function useIsAdvanced(): boolean {
  return useIsDev();
}

/** Semantic boolean accessor — true while developer mode is on, on any surface. */
export function useIsDev(): boolean {
  // Value subscriptions, not `usePreference`: ~40 always-mounted consumers (rail,
  // avatar, every Advanced gate) re-render only when one of THESE two changes,
  // not on every preference save.
  const dev = usePreferenceValue<boolean>(PrefKey.DEV_MODE);
  const stored = usePreferenceValue<string>(PrefKey.VIEW_MODE);
  return isDevOn(dev, stored);
}

/**
 * The mode for TIER questions — which rail items, which browseable types: Dev
 * with developer mode on, else the base tier. Never the surface on screen:
 * a terminal tab and a Vibe tab offer the same app around them.
 */
export function useTierMode(): ViewMode {
  return useIsDev() ? ViewMode.Dev : UNSTATED_VIEW_MODE;
}

/** Semantic boolean accessor — true only in Vibe mode (the simplest creator skin). */
export function useIsVibe(): boolean {
  return useViewMode() === ViewMode.Vibe;
}
