import { dataContext } from '@sdk';
import type { TranslationTarget } from '@sdk/models';

/**
 * The document-translation target languages, sourced from the backend bootstrap
 * payload (`BootstrapInfo.translation_targets`, single source of truth:
 * `flow_sdk/i18n/translation_targets.py`). DISTINCT from the app-UI locales in
 * `useSupportedLocales()` — never hardcode the list here.
 *
 * The list is static after bootstrap, so a plain read is enough; it is small
 * (~30 rows) and the picker re-renders from it directly.
 */
export function useTranslationTargets(): TranslationTarget[] {
  return dataContext.bootstrapInfo?.translation_targets ?? [];
}
