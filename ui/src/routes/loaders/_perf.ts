// Moved to `ts_sdk/src/utils/perf.ts` — the SDK needs the same helpers, and
// three of its modules had hand-rolled copies. Re-exported here because this
// path is what the loaders and their test import.
export { PERF_T0_KEY, markPerfT0, perfLog, perfTime } from '@sdk';
