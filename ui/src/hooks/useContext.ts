/**
 * Re-export of the SDK hook — see `@sdk/react/hooks/useContext`.
 *
 * The two copies had genuinely diverged: this one carried
 * `terminalRuntimeError`, the SDK one carried the user/version/workflow/sniffer
 * fields. Both sets read the same `dataContext` singleton, so the SDK snapshot
 * now takes the union and this file is a pointer at it.
 */
export { useContext } from '@sdk/react/hooks/useContext';
