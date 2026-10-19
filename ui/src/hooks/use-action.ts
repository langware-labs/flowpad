/**
 * Re-export of the SDK hook — see `@sdk/react/hooks/use-action`.
 *
 * The same-URL de-dup guard and its StrictMode reset were ported into the SDK
 * copy; this path stays so existing importers (and the mocks in
 * `use-action-strict-mode.test.tsx`) keep resolving.
 */
export { useAction } from '@sdk/react/hooks/use-action';
