// Shared setup file: shims `@lingui/react` for the unit/api/react test tiers.
// Those tiers render components in isolation (no <I18nProvider>), where the
// i18n migration's `useLingui()` / `<Trans>` would otherwise throw. The shim
// binds them to the activated source-locale i18n:
//   - useLingui() returns the global i18n (t/_ resolve to the English source
//     msgid via the empty default catalog) — what an unwrapped render produced
//     before i18n landed.
//   - <Trans> renders inside its own real I18nProvider so its INTERNAL hook
//     (not the exported useLingui) finds a context.
// I18nProvider is left as the actual export, so tests that DO wrap keep working.
//
// This lives in its own setup file (registered first in each tier's
// `setupFiles`) rather than being imported into each tier's setup module: the
// `vi.mock` call must appear literally in a transformed setup/test file to be
// hoisted correctly — a static `import { factory }` reference would be hoisted
// below the `vi.mock` and read before initialization.
import { vi } from 'vitest';

// Activate the source locale for the whole tier, exactly as `main.tsx` does by
// importing `i18n-init` first. The `vi.mock` factory below also does this, but
// only for a test that actually imports `@lingui/react` — and plain modules now
// resolve lazy `msg` descriptors through the shared `i18n._` (crumb labels, type
// labels, tree-root labels). A test that touches one of those without rendering
// a Lingui component would otherwise hit "called a translation function without
// setting a locale". Side-effect import, so it runs before any test module.
import '@src/i18n-init';

vi.mock('@lingui/react', async (importOriginal) => {
  const { createElement } = await import('react');
  const actual = await importOriginal<typeof import('@lingui/react')>();
  const { i18n } = await import('@lingui/core');
  await import('@src/i18n-init'); // ensure a locale is active before binding
  const bound = i18n.t.bind(i18n);
  return {
    ...actual,
    useLingui: () => ({ i18n, t: bound, _: bound }),
    Trans: (props: Record<string, unknown>) =>
      createElement(actual.I18nProvider, { i18n }, createElement(actual.Trans, props)),
  };
});
