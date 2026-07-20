import type { TranslationTarget } from '@sdk/models';
import type { TranslationView } from './useTranslations';

/**
 * Shared presentational bits for the translation pickers (`TranslationsPanel`
 * side tab + `DocLanguageSwitcher` inline popover), so the label lookup, the
 * "not-yet-added" derivation, and the two-line native/English label live in one
 * place instead of being copied per component.
 */

/** Resolve a lang code to its native + English names (falls back to the code). */
export function targetLabel(lang: string, targets: TranslationTarget[]): { native: string; english: string } {
  const t = targets.find((x) => x.code === lang);
  return { native: t?.nativeName ?? lang, english: t?.englishName ?? lang };
}

/** Targets that don't have a translation yet — the "Translate to" candidates. */
export function availableTargets(
  translations: TranslationView[],
  targets: TranslationTarget[],
): TranslationTarget[] {
  const added = new Set(translations.map((t) => t.lang));
  return targets.filter((t) => !added.has(t.code));
}

/** Two-line language label: native name over a muted English name (when they differ). */
export function LangLabel({ native, english }: { native: string; english: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span>{native}</span>
      {native !== english && <span className="text-xs text-muted-foreground">{english}</span>}
    </span>
  );
}
