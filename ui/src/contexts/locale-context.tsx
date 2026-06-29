import { i18n } from '@lingui/core';
import { useEffect, useState } from 'react';
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
 * Locale resolution (once, on load):
 *   1. an explicit user choice persisted in localStorage, else
 *   2. the closest supported match for `navigator.language`, else
 *   3. `en-US`.
 *
 * Catalogs are loaded lazily per locale (dynamic `*.po` import → `i18n.load` →
 * `i18n.activate`) so only the active locale's messages are fetched.
 */

export type Direction = 'ltr' | 'rtl';

export interface LocaleInfo {
  /** BCP-47-ish code used as the catalog key and `<html lang>`. */
  code: string;
  /** English name (for secondary label / search). */
  englishName: string;
  /** Endonym — the language's own name. */
  nativeName: string;
  /** Text direction; drives `<html dir>`. */
  dir: Direction;
  /** ISO 3166-1 alpha-2 region for the flag-icons SVG (language≠country; this
   *  is a chosen representative region, not a linguistic claim). */
  flag: string;
}

/**
 * Locales we actually ship translations for. The picker lists exactly these.
 * Add a row here (+ a `src/locales/<code>/messages.po`) to ship a new language.
 * The `dir` field is the code→direction map referenced throughout the plan.
 */
export const SUPPORTED_LOCALES: LocaleInfo[] = [
  { code: 'en-US', englishName: 'English', nativeName: 'English', dir: 'ltr', flag: 'us' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', dir: 'rtl', flag: 'il' },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية', dir: 'rtl', flag: 'sa' },
];

export const DEFAULT_LOCALE = 'en-US';
const LOCALE_KEY = 'locale';
const RECENTS_KEY = 'localeRecents';
const MAX_RECENTS = 4;

declare global {
  interface Window {
    setLocale: (code: string) => void;
    getLocale: () => string;
  }
}

function localeInfo(code: string): LocaleInfo {
  return (
    SUPPORTED_LOCALES.find((l) => l.code === code) ??
    SUPPORTED_LOCALES.find((l) => l.code === DEFAULT_LOCALE) ??
    SUPPORTED_LOCALES[0]
  );
}

function isSupported(code: string | null | undefined): code is string {
  return !!code && SUPPORTED_LOCALES.some((l) => l.code === code);
}

/** Match `navigator.language` (e.g. `he-IL`, `en`) against a supported code. */
function matchNavigatorLanguage(): string | null {
  const candidates = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  for (const raw of candidates) {
    if (!raw) continue;
    if (isSupported(raw)) return raw;
    // Fall back to a base-language match: `he-IL` → `he`, `en-GB` → `en-US`.
    const base = raw.split('-')[0].toLowerCase();
    const hit = SUPPORTED_LOCALES.find((l) => l.code.split('-')[0].toLowerCase() === base);
    if (hit) return hit.code;
  }
  return null;
}

function readInitialLocale(): string {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (isSupported(stored)) return stored;
  } catch {
    // localStorage may throw in private mode — fall through to detection.
  }
  return matchNavigatorLanguage() ?? DEFAULT_LOCALE;
}

let _locale: string = readInitialLocale();
const _listeners = new Set<(code: string) => void>();

function applyLocaleAttributes(code: string): void {
  const info = localeInfo(code);
  const root = document.documentElement;
  root.lang = info.code;
  root.dir = info.dir;
}

/** Load (if needed) and activate a locale's catalog in the shared i18n instance. */
async function loadAndActivate(code: string): Promise<void> {
  if (!i18n.messages || i18n.locale !== code) {
    const { messages } = await import(`../locales/${code}/messages.po`);
    i18n.load(code, messages);
  }
  i18n.activate(code);
}

/**
 * Activate the resolved locale and set the root attributes. Call once before
 * `ReactDOM.render` so the very first paint is in the right language/direction.
 */
export async function initLocale(): Promise<void> {
  applyLocaleAttributes(_locale);
  await loadAndActivate(_locale);
}

/**
 * Recently-selected locales (most-recent-first), used to pin the active +
 * recently-used languages in a dedicated section at the top of the picker.
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
  _locale = next;
  try {
    localStorage.setItem(LOCALE_KEY, next);
  } catch {
    // ignore persistence failures (private mode)
  }
  pushRecent(next);
  await loadAndActivate(next);
  applyLocaleAttributes(next);
  _listeners.forEach((fn) => fn(next));
}

export function getLocale(): string {
  return _locale;
}

defineGlobal('setLocale', setLocale);
defineGlobal('getLocale', getLocale);

/** Reactive accessor for the active locale code. */
export function useLocale(): string {
  const [code, setCode] = useState(_locale);
  useEffect(() => {
    _listeners.add(setCode);
    return () => {
      _listeners.delete(setCode);
    };
  }, []);
  return code;
}

/** Reactive accessor for the full active LocaleInfo. */
export function useLocaleInfo(): LocaleInfo {
  return localeInfo(useLocale());
}
