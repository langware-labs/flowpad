/// <reference types="vitest/globals" />

// The `react` vitest project runs with `globals: true`
// (tests/react/vitest.config.ts), so `describe` / `it` / `expect` are injected
// rather than imported. Without this reference `tsc` reports them as undefined
// names — 48 bogus TS2304s that drowned out the real ones the undefined-name
// gate exists to catch (scripts/check-undefined-names.js).
