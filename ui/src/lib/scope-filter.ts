/**
 * Scope-filter helpers now live in the SDK (`ts_sdk/src/utils/scope-filter.ts`)
 * so both the UI and the SDK (`getTabName`, `DockPointer`) share one home for
 * the option-key grammar. This shim keeps the existing `@src/lib/scope-filter`
 * imports working.
 */
export * from '@sdk/utils/scope-filter';
