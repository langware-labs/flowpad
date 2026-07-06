import { i18n } from '@lingui/core';
import { useSyncExternalStore } from 'react';
import { instancePreferences, InstancePreferencesEvent, PrefKey } from '@sdk';
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
 * The footer picker is shown ONLY when the intersection is 2+ (a genuine choice).
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
  return (
    supported.find((l) => l.code === code) ??
    supported.find((l) => l.code === DEFAULT_LOCALE) ??
    supported[0]
  );
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
  return typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
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

export async function setLocale(code: string): Promise<void> {
  const next = isSupported(code) ? code : DEFAULT_LOCALE;
  instancePreferences.set(PrefKey.LOCALE, next); // mirrors to localStorage (boot key)
  pushRecent(next);
  await loadAndActivate(next);
  applyLocaleAttributes(next);
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
instancePreferences.on(InstancePreferencesEvent.PREFERENCES_CHANGED, () => void onPrefLocaleChanged());
instancePreferences.on(InstancePreferencesEvent.PREFERENCES_LOADED, () => void onPrefLocaleChanged());

defineGlobal('setLocale', setLocale);
defineGlobal('getLocale', getLocale);

/** Reactive accessor for the active locale code. */
export function useLocale(): string {
  const [value] = usePreference<string>(PrefKey.LOCALE);
  return isSupported(value) ? value : DEFAULT_LOCALE;
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

/**
 * Whether to show the footer language picker: only when the OS reports 2+
 * languages we support (a genuine choice). With 0 or 1 we auto-select and hide
 * the chip — so a machine with no Arabic never sees an Arabic option.
 */
export function useShowLocaleChip(): boolean {
  useSupportedLocales(); // re-evaluate when the backend list arrives
  return systemIntersection().length >= 2;
}
