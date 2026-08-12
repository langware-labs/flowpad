import { i18n } from '@lingui/core';
import { useSyncExternalStore } from 'react';
import {
  ContextEventType,
  dataContext,
  dataManager,
  instancePreferences,
  InstancePreferencesEvent,
  isHubOnly,
  PrefKey,
  type Project,
} from '@sdk';
import type { SupportedLocale } from '@sdk/models';
import { usePreference } from '@src/hooks/use-preference';
import { defineGlobal } from '@sdk/utils';

/**
 * Locale + text-direction source of truth.
 *
 * Mirrors `view-mode-context.tsx`: module-level state + a listener set, with the
 * active value reflected as attributes on the document root (`lang` + `dir`) and
 * applied on import so they're present on first paint. This module is the SINGLE
 * writer of `document.documentElement.dir` — Tailwind `rtl:`/logical utilities,
 * the Radix `DirectionProvider`, and the Milkdown bidi plugin all derive
 * direction from it. Nothing else should set `dir`.
 *
 * The set of SUPPORTED locales is owned by the BACKEND and delivered via the
 * `bootstrap` payload (`BootstrapInfo.supported_locales`); this module no longer
 * hardcodes it. `applySupportedLocales` installs it post-bootstrap; until then a
 * minimal en-US fallback covers first paint.
 *
 * Locale resolution:
 *   1. an explicit user choice persisted in localStorage → always wins, else
 *   2. the system-intersection auto-rules (first run only), against the OS
 *      languages (`navigator.languages`) ∩ supported:
 *        - 0 matches → `en-US`
 *        - exactly 1 → that language
 *        - 2+        → the best system match; the footer chip lets them switch.
 *
 * The footer picker is shown whenever the BACKEND ships 2+ locales. The OS
 * intersection above only picks the first-run DEFAULT — it never decides whether
 * the picker is offered (see `LanguageSelector`).
 *
 * Catalogs are loaded lazily per locale (dynamic `*.po` import → `i18n.load` →
 * `i18n.activate`) so only the active locale's messages are fetched.
 */

/** A supported-locale descriptor. Same shape the backend ships via bootstrap —
 *  aliased to the SDK's `SupportedLocale` so there's a single definition. */
export type LocaleInfo = SupportedLocale;

export const DEFAULT_LOCALE = 'en-US';
const LOCALE_KEY = 'locale';
const RECENTS_KEY = 'localeRecents';
const MAX_RECENTS = 4;

/**
 * Pre-bootstrap fallback: the supported-locale list is owned by the BACKEND and
 * delivered via the `bootstrap` payload (`BootstrapInfo.supported_locales`). The
 * UI no longer hardcodes the list. Until `applySupportedLocales` is called (from
 * the root loader, right after bootstrap), we know only English — enough for the
 * very first paint and for any import-time `t` macro calls. `dir` here drives
 * `<html dir>` and `flag` is presentational (flag-icons SVG); both come from the
 * backend descriptor for every real locale.
 */
const FALLBACK_LOCALES: LocaleInfo[] = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr', flag: 'us' },
];

// Module-level supported-locale state + listener set (mirrors view-mode-context's
// module-state pattern). `applySupportedLocales` is the single writer; React reads
// it reactively via `useSupportedLocales` (useSyncExternalStore).
let _supported: LocaleInfo[] = FALLBACK_LOCALES;
const _supportedListeners = new Set<() => void>();

/** Current supported locales (backend-derived, or the en-US fallback pre-bootstrap). */
export function getSupportedLocales(): LocaleInfo[] {
  return _supported;
}

declare global {
  interface Window {
    setLocale: (code: string) => void;
    getLocale: () => string;
  }
}

function localeInfo(code: string): LocaleInfo {
  const supported = getSupportedLocales();
  return supported.find((l) => l.code === code) ?? supported.find((l) => l.code === DEFAULT_LOCALE) ?? supported[0];
}

function isSupported(code: string | null | undefined): code is string {
  return !!code && getSupportedLocales().some((l) => l.code === code);
}

/** Match one navigator language tag (e.g. `he-IL`, `en`) to a supported code, or null. */
function matchLanguageTag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const supported = getSupportedLocales();
  if (supported.some((l) => l.code === raw)) return raw;
  // Fall back to a base-language match: `he-IL` → `he`, `en-GB` → `en-US`.
  const base = raw.split('-')[0].toLowerCase();
  const hit = supported.find((l) => l.code.split('-')[0].toLowerCase() === base);
  return hit ? hit.code : null;
}

/** Navigator (OS-preference) language tags, in order. */
function navigatorLanguages(): readonly string[] {
  return typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
}

/**
 * Supported locales the OS actually reports (intersection of `navigator.languages`
 * with `getSupportedLocales()`), de-duped, in navigator (OS-preference) order. This
 * is the "what's installed on the system" signal — in the Electron renderer
 * `navigator.languages` mirrors the OS language list (no native API needed).
 */
export function systemIntersection(): LocaleInfo[] {
  const seen = new Set<string>();
  const out: LocaleInfo[] = [];
  for (const raw of navigatorLanguages()) {
    const code = matchLanguageTag(raw);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(localeInfo(code));
  }
  return out;
}

function applyLocaleAttributes(code: string): void {
  const info = localeInfo(code);
  const root = document.documentElement;
  root.lang = info.code;
  root.dir = info.dir;
}

// Locales whose catalog has actually been `i18n.load`-ed. We can't infer this
// from `i18n.locale`/`i18n.messages`: `i18n-init.ts` pre-activates en-US with NO
// catalog so import-time `t` calls are safe, which leaves `i18n.locale === 'en-US'`
// but no messages loaded. Tracking loads explicitly avoids the "Messages for
// locale … not loaded" warning (and re-importing an already-loaded catalog).
const _loaded = new Set<string>();

/** Load (if needed) and activate a locale's catalog in the shared i18n instance. */
async function loadAndActivate(code: string): Promise<void> {
  if (!_loaded.has(code)) {
    const { messages } = await import(`../locales/${code}/messages.po`);
    i18n.load(code, messages);
    _loaded.add(code);
  }
  i18n.activate(code);
}

/**
 * Resolve the locale to use at boot. An explicit prior choice always wins; the
 * system-intersection auto-rules only fire on first run (no stored choice):
 *   - 0 system-supported languages → `en-US`
 *   - exactly 1 → that language
 *   - 2+ → the best system match (navigator order); the chip lets them switch.
 * Must be called AFTER `applySupportedLocales` (the rules need the backend list).
 */
function resolveInitialLocale(): { code: string; hadStored: boolean } {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCALE_KEY) : null;
  if (isSupported(stored)) return { code: stored, hadStored: true };
  const inter = systemIntersection();
  if (inter.length === 0) return { code: DEFAULT_LOCALE, hadStored: false };
  return { code: inter[0].code, hadStored: false };
}

export function getLocale(): string {
  const code = instancePreferences.get(PrefKey.LOCALE) as string;
  return isSupported(code) ? code : DEFAULT_LOCALE;
}

/**
 * Recently-selected locales (most-recent-first), used to pin the active +
 * recently-used languages in a dedicated section at the top of the picker. Kept a
 * per-device localStorage cache (not a follow-me preference).
 */
export function getRecentLocales(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(arr)) return arr.filter(isSupported);
  } catch {
    // ignore parse/storage failures
  }
  return [];
}

function pushRecent(code: string): void {
  const next = [code, ...getRecentLocales().filter((c) => c !== code)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore persistence failures
  }
}

/**
 * Per-project language memory: every locale change (footer picker, the project's
 * own Language card, `window.setLocale`) converges in `setLocale`, which stamps
 * the current project — so the language a project is read in follows the project.
 * The equality guard breaks the apply→record feedback loop: `applyProjectLocale`
 * → `setLocale(project.locale)` lands here with an already-matching value and
 * no-ops. Mirrors `stampProjectViewMode` in view-mode-context.
 */
function stampProjectLocale(project: Project | null | undefined, code: string): void {
  if (!project || project.locale === code) return;
  // Hub: same hazard as view mode — the hub's project schema has no `locale`, so
  // `toJSON` would emit a full-row PUT missing it AND missing `name`, wiping the
  // name off every project the hub loads. Don't write projects from here on the hub.
  if (isHubOnly()) return;
  project.locale = code;
  void project.save().catch((err) => {
    console.warn('[locale] failed to record locale on project', err);
  });
}

/**
 * Make a locale the active one — preference, recents, catalog, `<html>` attrs.
 * Deliberately does NOT touch the current project: this is "show the app in this
 * language", not "the user chose this language for this project". Only
 * `setLocale` (a real user choice) records onto the project.
 */
async function activateLocale(code: string): Promise<void> {
  instancePreferences.set(PrefKey.LOCALE, code); // mirrors to localStorage (boot key)
  pushRecent(code);
  await loadAndActivate(code);
  applyLocaleAttributes(code);
}

export async function setLocale(code: string): Promise<void> {
  const next = isSupported(code) ? code : DEFAULT_LOCALE;
  stampProjectLocale(dataContext.project, next);
  await activateLocale(next);
}

/**
 * Apply a project's remembered language. Driven by the context subscription
 * below — NOT wired to any one route — so every way of entering a project gets
 * it (see `onCurrentProjectChanged`).
 *
 * A stored supported `locale` switches the app exactly as the footer picker
 * would. NO stored locale means English: an unset (or unrecognized) project
 * opens in `DEFAULT_LOCALE` rather than inheriting whatever language happened
 * to be active — a project's language is a property of the project, so an
 * unanswered one must not silently take the colour of the last project you were
 * in. Unset is left unset on the row, not stamped: `en-US` here is the meaning
 * of "no answer", not an answer the user gave. It becomes a real stored value
 * the moment they pick one (via the Language card or the footer chip, both of
 * which converge in `setLocale` → `stampProjectLocale`).
 *
 * The switch is fire-and-forget so no caller waits on it (the URL-first rule
 * keeps loaders fast); `<html lang/dir>` and the Lingui catalog land a tick
 * later, as they do for a footer switch.
 */
export function applyProjectLocale(project: Project): void {
  // Hub: not the surface a project is WORKED in — and the hub's bootstrap ships
  // no `supported_locales`, so every real code reads as unsupported there and
  // this would resolve to en-US and yank a Hebrew reader into English on a page
  // that has no per-project language to offer instead. Leave their choice alone.
  if (isHubOnly()) return;
  const target = isSupported(project.locale) ? project.locale : DEFAULT_LOCALE;
  if (target === getLocale()) return;
  void activateLocale(target).catch((err) => {
    console.warn('[locale] failed to apply project locale', err);
  });
}

/** Resolve, (optionally) persist the first-run pick, set `<html>` attrs, activate. */
async function resolveAndApply(persistFirstRun: boolean): Promise<void> {
  const { code, hadStored } = resolveInitialLocale();
  // Seed the first-run auto-pick into prefMan (a boot key → mirrored to
  // localStorage) so `useLocale`/`useLocaleInfo` reflect it and it sticks. Only
  // done once the real backend list is in (persistFirstRun) — never for the
  // pre-bootstrap en-US fallback, or it would masquerade as an explicit choice
  // and suppress the system-intersection rules. An explicit choice is untouched.
  if (persistFirstRun && !hadStored) instancePreferences.set(PrefKey.LOCALE, code);
  applyLocaleAttributes(code);
  await loadAndActivate(code);
}

/**
 * First, pre-paint pass: resolve from a stored choice (or en-US fallback) and
 * activate so the very first paint is in the right language/direction. Runs
 * before bootstrap, so the supported list is still the en-US fallback — does NOT
 * persist. Call once before `ReactDOM.render`. The real list arrives later via
 * `applySupportedLocales` (root loader, post-bootstrap).
 */
export async function initLocale(): Promise<void> {
  await resolveAndApply(false);
}

/**
 * Install the backend-provided supported locales (notifying reactive readers)
 * and re-resolve the active locale against them (persisting a first-run
 * auto-pick). Call once after bootstrap, from the root loader, before the app
 * tree mounts.
 */
export async function applySupportedLocales(list: LocaleInfo[] | null | undefined): Promise<void> {
  _supported = list && list.length > 0 ? list : FALLBACK_LOCALES;
  _supportedListeners.forEach((fn) => fn());
  await resolveAndApply(true);
  // From here on a project's language can actually be resolved, so start
  // following the current project (see `ensureProjectLocaleSync`) — and
  // RECONCILE THE ONE THAT IS ALREADY CURRENT.
  //
  // The catch-up is the load-bearing half, not defensiveness. `loadRoot` is
  // `initSdk()` then this, and `initSdk` adopts `bootstrapInfo.default_project`
  // — so on a provisioned box the project is current BEFORE anything here is
  // listening, and the event a subscription waits for is already in the past.
  // A real sandbox proved it: the box carried `locale='he'`, ran the build with
  // the subscription in it, and still opened in English.
  //
  // After `resolveAndApply` deliberately: that re-resolves the app's own stored
  // choice, and the project must have the final say over the surface it owns.
  ensureProjectLocaleSync();
  await onCurrentProjectChanged(true);
}

// React to prefMan-driven locale changes (a backend value reconciled in on load, or a
// change from another surface): load + activate the catalog and set <html> attributes.
async function onPrefLocaleChanged(): Promise<void> {
  const code = getLocale();
  if (i18n.locale !== code) {
    await loadAndActivate(code);
    applyLocaleAttributes(code);
  }
}
/**
 * The language follows the CURRENT PROJECT, however it became current.
 *
 * Deliberately hung off the context change rather than a route loader. Becoming
 * "in" a project is not one code path: a loader does it, but so do the project
 * picker, quick-create, the task/conversation/asset loaders adopting an entity's
 * owner, the boot-time restore, and — the one that made this non-negotiable —
 * `initSdk` adopting `bootstrapInfo.default_project`, which is how a provisioned
 * SANDBOX adopts the project it was built for. Wired to `loadProject` alone, a
 * box opened its Hebrew project reading English, and each of the other writers
 * was the same bug waiting for someone to walk into it.
 *
 * `setContextEntityTypeId` is the single choke point all of them funnel through
 * and it already early-returns on an unchanged TypeId, so this fires exactly
 * once per real switch. The id guard here covers the rest of CONTEXT_CHANGED,
 * which is emitted for every context key, not just the project.
 *
 * Leaving a project (id → null) deliberately does NOT change the language:
 * there is no project asking for one, and yanking the user's language on the
 * way out would be a change nobody requested.
 */
let _localeProjectId: string | null = null;

/**
 * @param reconcile true = apply the CURRENT project's language even though the
 *   id has not changed. The id guard exists to ignore the rest of
 *   CONTEXT_CHANGED (it fires for every context key), but "already current" is
 *   exactly the boot case — so the catch-up must not be filtered out by it.
 *   `applyProjectLocale` no-ops when the language already matches, so forcing
 *   costs nothing.
 */
async function onCurrentProjectChanged(reconcile = false): Promise<void> {
  const typeId = dataContext.projectTypeId;
  const id = typeId?.id ?? null;
  if (!reconcile && id === _localeProjectId) return;
  _localeProjectId = id;
  if (!id || !typeId) return;
  // Usually already cached (whoever set the context had the entity in hand);
  // fetch only when it isn't, and let a failure pass — a language is not worth
  // failing a navigation over.
  const project =
    dataContext.project?.id === id
      ? dataContext.project
      : await dataManager.getByTypeId<Project>(typeId).catch(() => null);
  if (project) applyProjectLocale(project);
}

let _projectLocaleSyncInstalled = false;

/**
 * Installed from `applySupportedLocales`, not at module import.
 *
 * Two reasons, and the first is the real one: before the backend's locale list
 * is in, `isSupported('he')` is false and every project would resolve to en-US —
 * the subscription has nothing correct to do until then. The second is that this
 * module is pulled in transitively by `i18n-init`, so subscribing at import time
 * made every unit test that mocks `@sdk` with a partial `dataContext` fail on
 * `dataContext.on is not a function`.
 */
function ensureProjectLocaleSync(): void {
  if (_projectLocaleSyncInstalled) return;
  _projectLocaleSyncInstalled = true;
  dataContext.on(ContextEventType.CONTEXT_CHANGED, () => void onCurrentProjectChanged());
}

instancePreferences.on(InstancePreferencesEvent.PREFERENCES_CHANGED, () => void onPrefLocaleChanged());
instancePreferences.on(InstancePreferencesEvent.PREFERENCES_LOADED, () => void onPrefLocaleChanged());

defineGlobal('setLocale', setLocale);
defineGlobal('getLocale', getLocale);

/**
 * Reactive accessor for the active locale code.
 *
 * Reads BOTH stores, and must: the preference holds the code, but whether that
 * code counts is decided by the backend-derived supported list — and that list
 * lands with bootstrap, one root-loader tick AFTER this tree first renders.
 * Until it does, a stored `he` reads as unsupported and this answers `en-US`.
 * Subscribing to the list (not merely reading it) is what re-renders when the
 * real one arrives; without it the React-side answer freezes at that
 * pre-bootstrap `en-US` for the whole session, because the preference never
 * changes afterwards and so never notifies. That froze `<DirectionProvider>` at
 * `ltr` while `<html dir>` — written imperatively — correctly went `rtl`, and
 * every Radix primitive that stamps its own `dir` (Tabs.Root) then pinned its
 * whole subtree left-to-right against the document.
 */
export function useLocale(): string {
  const supported = useSupportedLocales();
  const [value] = usePreference<string>(PrefKey.LOCALE);
  return supported.some((l) => l.code === value) ? value : DEFAULT_LOCALE;
}

/** Reactive accessor for the full active LocaleInfo. */
export function useLocaleInfo(): LocaleInfo {
  return localeInfo(useLocale());
}

/** Reactive accessor for the backend-derived supported locales. */
export function useSupportedLocales(): LocaleInfo[] {
  return useSyncExternalStore(
    (cb) => {
      _supportedListeners.add(cb);
      return () => _supportedListeners.delete(cb);
    },
    getSupportedLocales,
    getSupportedLocales,
  );
}
