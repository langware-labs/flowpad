// Shared setup for the `api` test tier.
//
// FULL cleanup (per-test purge + leak sweep), not just a tripwire. This tier was
// long assumed "temp-isolated and self-cleaning" — it is not. The temp records
// root isolates the metadata shadow only; a `POST /graph/skill` still materialises
// a REAL `<user_home>/.claude/skills/<name>/` folder on the live backend this tier
// talks to. And a tripwire alone cannot see it: `assertNoLeaks` matches the
// `e2etest-*` marker, so a test that names its entities anything else leaks
// silently past a green run.
//
// That combination is how 183 `scan_skill_*` / `index_skill_*` / `full_cycle_skill_*`
// folders accumulated in the real `~/.claude/skills` from one passing test file.
// Installing here — in the tier's setupFile — makes teardown the DEFAULT rather
// than a per-file opt-in a new test can forget. `installCleanup` is idempotent and
// accumulates `sweepTypes`, so files that also call it themselves stay correct.
import { installCleanup } from '../_cleanup';
import { connectionManager } from '@sdk';
import { afterAll } from 'vitest';
import { assertClaudeTranscriptHomesAligned } from './_claude_transcript_home';

assertClaudeTranscriptHomesAligned();
installCleanup({ sweepTypes: ['skill'] });

afterAll(() => {
  connectionManager.dispose();
});

// The `@lingui/react` shim is registered in its own setup file (../_lingui-mock,
// listed first in this tier's setupFiles) and shared with the unit/react tiers.
