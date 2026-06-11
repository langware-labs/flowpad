'use strict';

/*
 * Tests for ./flow-rs-keychain.js pure logic (sodKeyAccount). The binary-exec
 * paths (getKeyRestricted/setKeyRestricted) need the signed flow-rs binary and
 * a real OS keychain, so they're out of scope for a unit test.
 * Run: `node electron/flow-rs-keychain.test.js`.
 */

const assert = require('assert');
const { sodKeyAccount } = require('./flow-rs-keychain');

let passed = 0;
function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
  passed++;
}

const prev = process.env.FLOW_INSTANCE;

// Default instance is `prod` when FLOW_INSTANCE is unset.
delete process.env.FLOW_INSTANCE;
eq(sodKeyAccount(), 'prod.flow-rs', 'unset FLOW_INSTANCE → prod.flow-rs');

// The account is always suffixed `.flow-rs` so the flow-rs-owned entry never
// collides with a stale keytar / python3.x entry at the bare instance slot.
process.env.FLOW_INSTANCE = 'oss';
eq(sodKeyAccount(), 'oss.flow-rs', 'FLOW_INSTANCE=oss → oss.flow-rs');

process.env.FLOW_INSTANCE = 'dev-1';
eq(sodKeyAccount(), 'dev-1.flow-rs', 'named instance preserved verbatim + suffix');

// Restore the environment so this test has no side effects on the runner.
if (prev === undefined) delete process.env.FLOW_INSTANCE;
else process.env.FLOW_INSTANCE = prev;

console.log(`flow-rs-keychain.test.js: ${passed} assertions passed`);
