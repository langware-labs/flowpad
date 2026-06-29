---
id: 139ec1ca-3d3e-566b-bccb-b37f8940cc15
---

# FE Test Migrator Memory

## Removed SDK Features

### BaseSkillTypes enum (removed)
- `BaseSkillTypes` enum was deleted from `ts_sdk/src/entities/agent.ts`
- `skill` getter/setter removed from `CompletionOptions` class
- `skill` field removed from `IChatOptionsValues`, `IChatOptions`, and `ChatOptionsState`
- `isSkillLabel` function still exists in `ts_sdk/src/utils/skill-labels.ts`
- Tests referencing `flow.options.skill`, `flow.state.chat_options.skill`, or `BaseSkillTypes` must be removed

## Test Patterns

### Running specific tests
- `npx vitest run --project react -t "Test Name"` filters by test name (skips non-matching)
- The `--` file path filter doesn't isolate files well; use `-t` for name filtering

### Vitest workspace config
- Root config at `ui/vitest.config.ts` defines projects: unit, api, react
- Each project extends from its suite-specific config (e.g., `tests/react/vitest.config.ts`)
- Include patterns: `tests/{suite}/**/*.test.{ts,tsx}`

### Global ontologyStore is empty
- `createSkillsOntology()` removed from `ts_sdk/src/stores/ontology-store.ts`
- The global `ontologyStore` singleton (exported from `@sdk`) has NO ontologies registered at import time
- Tests that call `ontologyStore.getLabelInfo('--skill--...')` expecting data will get `null`
- Fix: create a local `OntologyStore` in `beforeEach` and register test ontologies manually
- Affected files: `test-label-ontology.test.ts`, `test-resolvable-ontology.test.ts`

## Fixed Tests

### test-resolvable-labels.test.tsx (2026-03-02)
- Category: API_DRIFT (removed SDK feature)
- Removed: `BaseSkillTypes` import, all skill-related tests (Test 2, 3, 4, 5, skill edge cases in Test 6)
- Removed: React rendering wrapper and related imports (only needed by skill tests)
- Kept: Test 1 (Resolvable Pattern Basics), Test 6 edge cases (empty arrays, null modelChoice)
- Result: 4/4 tests PASS

### test-label-ontology.test.ts (2026-03-02)
- Category: API_DRIFT (removed SDK feature)
- Removed: `BaseSkillTypes` import, `ontologyStore` import
- Removed: entire "Builtin Skills Ontology" describe block (3 tests testing BaseSkillTypes registration)
- Kept: LabelInfo tests (4), parseLabel tests (4), Ontology tests (5), OntologyStore tests (8), Integration tests (2)
- Fixed: Integration tests now create local `OntologyStore` with skill ontology in `beforeEach` instead of relying on global `ontologyStore`
- Result: 23/23 tests PASS
