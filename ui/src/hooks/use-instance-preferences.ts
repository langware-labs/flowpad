/**
 * Re-export of the SDK hook — see `@sdk/react/hooks/use-instance-preferences`.
 *
 * The module-level shared subscriber set was ported into the SDK copy: it keeps
 * the singleton's listener count at 2 however many components mount, instead of
 * attaching a fresh pair per hook instance.
 */
export { useInstancePreferences } from '@sdk/react/hooks/use-instance-preferences';
