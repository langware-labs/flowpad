// vitest reporter: append test events for `flow test run` (see flow_sdk/testing/__init__.py).
//
// Added by `flow test run` to a vitest command as `--reporter=<this file>`, next to
// `--reporter=default`. Writes nothing unless $FLOW_TEST_EVENTS names a file.
import { appendFileSync } from 'node:fs';

const path = process.env.FLOW_TEST_EVENTS;

function write(event) {
  if (!path) return;
  appendFileSync(path, JSON.stringify(event) + '\n');
}

function idOf(testCase) {
  return `${testCase.module.moduleId.split('/tests/').pop()} › ${testCase.fullName}`;
}

/** A test filtered out by `-t` (or `.skip`) is not part of this run's work. */
function willRun(testCase) {
  return testCase.options.mode === 'run' || testCase.options.mode === 'only';
}

export default class FlowProgressReporter {
  onTestModuleCollected(testModule) {
    let n = 0;
    for (const testCase of testModule.children.allTests()) if (willRun(testCase)) n += 1;
    if (n) write({ event: 'collected', n });
  }

  onTestCaseReady(testCase) {
    if (willRun(testCase)) write({ event: 'start', id: idOf(testCase) });
  }

  onTestCaseResult(testCase) {
    if (!willRun(testCase)) return;
    const result = testCase.result();
    const outcome = result.state === 'passed' ? 'passed' : result.state === 'failed' ? 'failed' : 'skipped';
    const message = outcome === 'failed' ? String(result.errors?.[0]?.message ?? 'failed').split('\n')[0].slice(0, 300) : null;
    write({ event: 'result', id: idOf(testCase), outcome, message });
  }
}
