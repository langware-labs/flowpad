'use strict';

/*
 * Tests for ./shutdown.js — the quit → relaunch handoff.
 *
 * The bug this guards: the app used to exit on a 1s timer while its `flow stop`
 * child was still running. A non-detached execFile child is REPARENTED when its
 * parent exits, not killed, so that stop kept holding the instance lifecycle
 * lock and the next launch's `flow start` died with
 * "service_busy: Instance '<name>' is temporarily owned".
 *
 * The stop child here is a REAL subprocess spawned the way uv-manager spawns
 * `flow stop` (execFile, not detached), so "did the app exit while the stop was
 * still running" is answered against a real process, not a stand-in for one.
 *
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/shutdown.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createShutdown, relaunchAfterStop } = require('./shutdown');

const execFileAsync = promisify(execFile);

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed++;
}

const silentLog = { info() {}, warn() {}, error() {} };

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A backend owner whose stop() spawns a real child the same way
 * UvManager._flowStop does — execFile, not detached — and resolves only when
 * that child has exited. `pid` exposes the child so a test can ask the OS
 * whether it was still running at the moment the app exited. The child only has
 * to outlive the exit check -- what is under test is that run() awaits it at
 * all, which no length of sleep would prove better.
 */
function slowStopper(seconds) {
  let child = null;
  return {
    get pid() {
      return child && child.pid;
    },
    async stop() {
      const promise = execFileAsync(process.execPath, [
        '-e',
        `setTimeout(() => {}, ${seconds * 1000})`,
      ]);
      child = promise.child;
      await promise;
    },
  };
}

async function main() {
  // ── the exit must not happen while the stop child is still running ────────
  {
    const uvManager = slowStopper(0.15);
    let aliveAtExit = null;
    let exitCode = null;
    const shutdown = createShutdown({
      uvManager,
      log: silentLog,
      exit: code => {
        exitCode = code;
        aliveAtExit = isAlive(uvManager.pid);
      },
      relaunch: () => assert.fail('must not relaunch when none was requested'),
    });

    await shutdown.run();

    eq(exitCode, 0, 'exits 0 after a clean stop');
    eq(aliveAtExit, false,
      'the `flow stop` child must be gone before the app exits — an orphaned ' +
      'stop keeps the lifecycle lock and the next `flow start` gets service_busy');
    eq(shutdown.isRunning(), false, 'not running once the handoff is done');
  }

  // ── a launch arriving mid-stop is absorbed, then honoured ─────────────────
  {
    const uvManager = slowStopper(0.15);
    const order = [];
    const shutdown = createShutdown({
      uvManager,
      log: silentLog,
      exit: () => order.push('exit'),
      relaunch: () => order.push('relaunch'),
    });

    const done = shutdown.run();
    await new Promise(resolve => setImmediate(resolve));
    ok(shutdown.isRunning(), 'the stop is in flight');
    eq(shutdown.requestRelaunch(), true, 'a launch mid-stop is absorbed by the quit sequence');
    await done;

    eq(order, ['relaunch', 'exit'], 'relaunch is requested before the process exits');
  }

  // ── with no shutdown in flight the caller keeps its normal path ───────────
  {
    const shutdown = createShutdown({
      uvManager: { async stop() {} },
      log: silentLog,
      exit: () => {},
      relaunch: () => assert.fail('must not relaunch outside a shutdown'),
    });
    eq(shutdown.requestRelaunch(), false, 'no shutdown in flight → caller proceeds itself');
  }

  // ── a failing stop still exits rather than stranding the app ──────────────
  {
    let exitCode = null;
    const shutdown = createShutdown({
      uvManager: {
        async stop() {
          throw new Error('flow stop blew up');
        },
      },
      log: silentLog,
      exit: code => {
        exitCode = code;
      },
      relaunch: () => assert.fail('must not relaunch when none was requested'),
    });

    await shutdown.run();
    eq(exitCode, 0, 'a failed stop still exits');
  }

  // ── a reopen must not abandon a backend stop that is still running ────────
  {
    const uvManager = slowStopper(0.15);
    const pendingStop = uvManager.stop();
    let aliveAtExit = null;
    const order = [];

    await relaunchAfterStop({
      pendingStop,
      log: silentLog,
      relaunch: () => order.push('relaunch'),
      exit: () => {
        order.push('exit');
        aliveAtExit = isAlive(uvManager.pid);
      },
    });

    eq(order, ['relaunch', 'exit'], 'relaunches, then exits');
    eq(aliveAtExit, false,
      'the startup-timeout path\'s stop must finish before the reopen relaunches — ' +
      'abandoning it strands the same lock the quit bug stranded');
  }

  // ── with no stop in flight the reopen relaunches straight away ────────────
  {
    const order = [];
    await relaunchAfterStop({
      pendingStop: null,
      log: silentLog,
      relaunch: () => order.push('relaunch'),
      exit: () => order.push('exit'),
    });
    eq(order, ['relaunch', 'exit'], 'no pending stop → relaunch immediately');
  }

  console.log(`shutdown.test.js: ${passed} assertions passed`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
