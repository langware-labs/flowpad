import type { ChunkScenario } from '../generator/TestSequenceGenerator.js';
import type { EnvSetup } from '../types.js';

export interface ScenarioDef {
  label: string;
  scenarios: ChunkScenario[];
  env: EnvSetup;
}

const BASE_ENV: EnvSetup = {
  cols: 80, rows: 24, cellHeight: 14, cellWidth: 7, scrollbackLines: 200, seed: 42,
};

function env(overrides: Partial<EnvSetup> = {}): EnvSetup {
  return { ...BASE_ENV, ...overrides };
}

export const PREDEFINED_SCENARIOS: Record<string, ScenarioDef> = {
  'normal-10': {
    label: 'Normal Lines (10 × 79 chars)',
    scenarios: Array.from({ length: 10 }, () => ({ type: 'normal', length: 79 }) satisfies ChunkScenario),
    env: env(),
  },

  'wrap-5': {
    label: 'Wrapping Lines (5 × 160 chars)',
    scenarios: Array.from({ length: 5 }, () => ({ type: 'normal', length: 160 }) satisfies ChunkScenario),
    env: env(),
  },

  'exact-cols': {
    label: 'Exact Width (5 × 80 chars — pending-wrap edge case)',
    scenarios: Array.from({ length: 5 }, () => ({ type: 'exact_cols' }) satisfies ChunkScenario),
    env: env(),
  },

  'overwrite-5': {
    label: 'CR Overwrite (5 commits × 3 drafts each)',
    scenarios: Array.from({ length: 5 }, () => (
      { type: 'overwrite', drafts: 3, finalLength: 79 }) satisfies ChunkScenario),
    env: env(),
  },

  'ansi-10': {
    label: 'ANSI Colors (10 colored lines)',
    scenarios: Array.from({ length: 10 }, (_, i) => (
      { type: 'ansi', length: 79, colorCode: `${31 + (i % 6)}` }) satisfies ChunkScenario),
    env: env(),
  },

  'wide-10': {
    label: 'Wide CJK Chars (10 lines × 10 wide chars)',
    scenarios: Array.from({ length: 10 }, () => ({ type: 'wide', wideChars: 10 }) satisfies ChunkScenario),
    env: env(),
  },

  'tabs-5': {
    label: 'Tab Expansion (5 lines × 4 tabs)',
    scenarios: Array.from({ length: 5 }, () => ({ type: 'tab', tabs: 4 }) satisfies ChunkScenario),
    env: env(),
  },

  'multiline-5': {
    label: 'Multiline Chunks (5 chunks × 3 lines each)',
    scenarios: Array.from({ length: 5 }, () => (
      { type: 'multiline', lines: 3, lengthPerLine: 79 }) satisfies ChunkScenario),
    env: env(),
  },

  'narrow-cols': {
    label: 'Narrow Terminal (cols=50, tag wraps)',
    scenarios: Array.from({ length: 8 }, () => ({ type: 'normal', length: 50 }) satisfies ChunkScenario),
    env: env({ cols: 50 }),
  },

  'mixed': {
    label: 'Mixed — All Scenario Types',
    scenarios: [
      { type: 'normal',    length: 79 },
      { type: 'normal',    length: 160 },
      { type: 'exact_cols' },
      { type: 'overwrite', drafts: 2, finalLength: 79 },
      { type: 'ansi',      length: 79, colorCode: '32' },
      { type: 'wide',      wideChars: 5 },
      { type: 'tab',       tabs: 3 },
      { type: 'multiline', lines: 2, lengthPerLine: 79 },
    ] satisfies ChunkScenario[],
    env: env(),
  },

  'stress-50': {
    label: 'Stress Test (50 normal lines)',
    scenarios: Array.from({ length: 50 }, () => ({ type: 'normal', length: 79 }) satisfies ChunkScenario),
    env: env({ scrollbackLines: 300 }),
  },

  // ── Mission-critical edge cases ──────────────────────────────────────────

  'overflow-scrollback': {
    label: 'Scrollback Overflow (300 lines, scrollback=50) — comment eviction',
    scenarios: Array.from({ length: 300 }, () => ({ type: 'normal', length: 79 }) satisfies ChunkScenario),
    env: env({ scrollbackLines: 50 }),
  },

  'single-event': {
    label: 'Single Event (1 packet — timeRange=0 degenerate case)',
    // minTimestamp === maxTimestamp → timeRange=0 → timeFraction must be 0, not NaN
    scenarios: [{ type: 'normal', length: 79 }] satisfies ChunkScenario[],
    env: env(),
  },

  'rapid-overwrite': {
    label: 'Rapid Overwrite (30 × 20 drafts — countdown timer pattern)',
    scenarios: Array.from({ length: 30 }, () => (
      { type: 'overwrite', drafts: 20, finalLength: 79 }) satisfies ChunkScenario),
    env: env({ scrollbackLines: 400 }),
  },

  'long-wrap': {
    label: 'Long Wrapping Lines (20 × 320 chars — 4 wrap rows each)',
    scenarios: Array.from({ length: 20 }, () => ({ type: 'normal', length: 320 }) satisfies ChunkScenario),
    env: env({ scrollbackLines: 400 }),
  },

  'tiny-scroll': {
    label: 'Tiny Scroll Steps (400 lines, scrollback=400) — fraction precision',
    scenarios: Array.from({ length: 400 }, () => ({ type: 'normal', length: 79 }) satisfies ChunkScenario),
    env: env({ scrollbackLines: 400 }),
  },

  'narrow-heavy-wrap': {
    label: 'Narrow Terminal Heavy Wrap (cols=20, 20 × 79-char lines)',
    scenarios: Array.from({ length: 20 }, () => ({ type: 'normal', length: 79 }) satisfies ChunkScenario),
    env: env({ cols: 20 }),
  },

  'eviction-stress-500': {
    label: 'Eviction Stress (500 lines, scrollback=60 — true xterm eviction)',
    scenarios: Array.from({ length: 500 }, () => ({ type: 'normal', length: 79 }) satisfies ChunkScenario),
    env: env({ scrollbackLines: 60 }),
  },
};
