'use strict';

/*
 * The startup journal (FLOWPAD-2231, part 3): which phase this launch reached, persisted as it
 * happens, so the NEXT launch can tell a run that ended cleanly from one that died before it
 * could show anything.
 *
 * Phases, in order:
 *   electron-initialized → renderer-loaded → backend-start → backend-healthy
 *                                          ↘ fatal-failure / startup-failed → recovery-update / recovery-failed
 *   clean-exit is written by before-quit.
 *
 * A previous record whose phase is not terminal means that run ended abnormally (a crash in the
 * main process, a kill, a power loss) before reaching a terminal phase. Two in a row put the
 * next launch in recovery mode: the panel first, with Update / Repair / Export logs, before the
 * backend is started again. This is the only crash recovery in-process JavaScript can do: a
 * main process that never launches cannot run it — see the report's "Electron crash recovery
 * limitations".
 *
 * Not a wall-clock cap: the backend gate (backend-wait.js) bounds the loading screen on
 * evidence; the journal records, it never kills.
 */

const PHASES = Object.freeze([
  'electron-initialized',
  'renderer-loaded',
  'backend-start',
  'backend-healthy',
  'fatal-failure',
  'startup-failed',
  'recovery-update',
  'recovery-failed',
  'clean-exit',
]);

// A run that reached one of these ended the way it meant to: it is not a crash.
const TERMINAL_PHASES = new Set(['backend-healthy', 'fatal-failure', 'startup-failed', 'recovery-update', 'recovery-failed', 'clean-exit']);

const DEFAULT_RECOVERY_THRESHOLD = 2;

/**
 * @param {object} o
 * @param {(path: string) => string} o.readFile
 * @param {(path: string, text: string) => void} o.writeFile
 * @param {string} o.filePath
 * @param {string} o.appVersion
 * @param {number} o.pid
 * @param {() => number} [o.now]
 * @param {{info?: Function, warn?: Function}} [o.log]
 */
function createStartupJournal({ readFile, writeFile, filePath, appVersion, pid, now = Date.now, log }) {
  let previous = null;
  try {
    const data = JSON.parse(readFile(filePath));
    if (data && typeof data === 'object' && typeof data.phase === 'string') previous = data;
  } catch { /* first run, or unreadable: nothing to compare with */ }

  const previousAbnormal = !!previous && !TERMINAL_PHASES.has(previous.phase);
  const abnormalRuns = previousAbnormal ? (Number(previous.abnormalRuns) || 0) + 1 : 0;

  const state = {
    runId: `${now()}-${pid}`,
    appVersion,
    pid,
    startedAt: new Date(now()).toISOString(),
    phase: null,
    phaseAt: null,
    abnormalRuns,
    history: [],
  };

  function persist() {
    try { writeFile(filePath, JSON.stringify(state, null, 2)); } catch (err) { if (log && log.warn) log.warn(`[startup-journal] could not write ${filePath}: ${err && err.message}`); }
  }

  function mark(phase, extra) {
    if (!PHASES.includes(phase)) throw new Error(`unknown startup phase: ${phase}`);
    state.phase = phase;
    state.phaseAt = new Date(now()).toISOString();
    state.history.push({ phase, at: state.phaseAt, ...(extra ? { extra } : {}) });
    if (log && log.info) log.info(`[startup] phase=${phase}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
    persist();
  }

  if (previousAbnormal && log && log.warn) {
    log.warn(`[startup] the previous run (${previous.appVersion}, pid ${previous.pid}) ended abnormally in phase "${previous.phase}" at ${previous.phaseAt} (${abnormalRuns} in a row)`);
  }

  return {
    mark,
    phase: () => state.phase,
    previous: () => previous,
    previousRunCrashed: () => previousAbnormal,
    consecutiveAbnormalRuns: () => abnormalRuns,
    /** Two abnormal endings in a row: show recovery before trying the backend again. */
    recoveryMode: (threshold = DEFAULT_RECOVERY_THRESHOLD) => abnormalRuns >= threshold,
    snapshot: () => ({ ...state, history: [...state.history] }),
  };
}

/** `--recovery` on the command line: the separate recovery entry point (a shortcut, a support instruction). */
function recoveryRequested(argv) {
  return (argv || []).some((a) => a === '--recovery' || a === '--flowpad-recovery');
}

/**
 * One backend start at a time. `run(name, fn)` executes fn unless another run is in flight,
 * in which case it returns `{ skipped: true, busy: <name of the running one> }` — the second
 * caller never spawns a second `flow start` under the first.
 */
function createStartGuard({ log } = {}) {
  let inFlight = null;
  return {
    get busy() { return inFlight; },
    async run(name, fn) {
      if (inFlight) {
        if (log && log.warn) log.warn(`[startup] "${name}" skipped: "${inFlight}" is still starting the backend`);
        return { skipped: true, busy: inFlight };
      }
      inFlight = name;
      try { return { skipped: false, result: await fn() }; } finally { inFlight = null; }
    },
  };
}

module.exports = { PHASES, TERMINAL_PHASES, DEFAULT_RECOVERY_THRESHOLD, createStartupJournal, recoveryRequested, createStartGuard };
