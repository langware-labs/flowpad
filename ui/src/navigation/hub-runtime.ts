// The canonical hub-mode signal lives in the SDK (where `dataContext` lives).
// Re-exported here so ui-layer callers keep a stable `@src/navigation` import.
export { isHubOnly } from '@sdk';
