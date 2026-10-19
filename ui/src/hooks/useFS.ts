/**
 * Re-export of the SDK hook — see `@sdk/react/hooks/useFS`.
 *
 * `revision()` and `refetch()` were ported into the SDK copy. `refetch` returns
 * `{ content, discardedDirty }` there instead of raising a toast: warning the
 * user is a UI concern and ts_sdk carries neither the notification store nor a
 * lingui catalog (the standalone SDK build registers no macro transform, so a
 * `t` macro would survive to runtime).
 */
export { useFS } from '@sdk/react/hooks/useFS';
