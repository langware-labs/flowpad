/**
 * Re-export shim — the tab store moved to `@src/tabs/useTabs` when it was
 * generalized from terminals-only to the unified `tabs` membership API
 * (docs/tab-management.md Part 3 §4). Every historical export keeps working
 * from this path; new code should import from `@src/tabs/useTabs` directly.
 */
export * from '@src/tabs/useTabs';
