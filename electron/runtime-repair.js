'use strict';

/*
 * Windows runtime repair — when application control blocks the Python the engine runs on.
 *
 * The failure (FLOWPAD-2009, FLOWPAD-2231): uv installs a python-build-standalone CPython,
 * whose files are unsigned. Smart App Control (default on new Windows 11 installs) and
 * enterprise application-control policies decide per FILE, on reputation: a build that is
 * new or rarely loaded has none, and the engine dies on an import with
 *
 *   ImportError: DLL load failed while importing _multiprocessing: An Application Control
 *   policy has blocked this file.
 *
 * Neither the user nor IT can allow-list a file under Smart App Control, and turning it off
 * is irreversible without reinstalling Windows — so the only repair that stays inside the
 * rules is to run the engine on an interpreter the policy accepts: the official python.org
 * build, signed by the Python Software Foundation. This module is the pure part of that:
 * what to detect, what to download, how to verify it, in what order, and when to roll back.
 * Every effect (download, signature check, installer, uv, backend) is injected, so the whole
 * flow is exercised without Windows (runtime-repair.test.js). uv-manager.js supplies the real
 * effects; main.js drives the panel.
 *
 * Python 3.11.9 is a compatibility fallback, not the runtime strategy: python.org stopped
 * shipping 3.11 binaries at 3.11.9, and the permanent answer (a signed, maintained runtime
 * with CI validation against application control) is a separate task.
 */

const path = require('path');

// ── The runtime manifest ─────────────────────────────────────────────────────
// The official CPython build for Windows x64 as the Python Software Foundation publishes it on
// NuGet: the SAME PSF-signed binaries the python.org installer lays down (identical SHA-256 for
// python.exe, python311.dll and every .pyd — audited on the Windows VM, 2026-10-10), but as a
// plain zip. NOT the python.org .exe installer: that bundle runs its own bootstrapper DLL
// (PythonBA.dll) from %TEMP%, and that DLL is UNSIGNED — under an enforced application-control
// policy the installer dies with 0x800711C7 before installing anything (reproduced on the VM,
// CodeIntegrity 3077 on PythonBA.dll, 3089: no signature). A zip has no bootstrapper: files are
// extracted and then EVERY exe/dll/pyd is Authenticode-checked before the interpreter is used.
// Versioned with the app; the SHA-256 was computed on 2026-10-10 from the file `url` serves.
// Change any field only together with the others.
const PYTHON_RUNTIME_MANIFEST = Object.freeze({
  version: '3.11.9',
  arch: 'amd64',
  source: 'nuget',
  url: 'https://api.nuget.org/v3-flatcontainer/python/3.11.9/python.3.11.9.nupkg',
  // Saved with a .zip name: the archive IS a zip, and the extractor insists on the extension.
  fileName: 'python.3.11.9.nupkg.zip',
  sha256: '9283876d58c017e0e846f95b490da3bca0fc0a6ee1134b2870677cfb7eec3c67',
  sizeBytes: 17478009,
  // Inside the archive the interpreter tree is `tools/`; it is moved to `python-<version>/`.
  archiveRoot: 'tools',
  // Signers accepted for every executable file of the extracted runtime (30 PSF + 2 Microsoft
  // runtime DLLs in 3.11.9). pip/setuptools ship 14 unsigned launcher stubs under
  // Lib\site-packages — that directory is removed before the check: uv manages packages, the
  // runtime is only a base interpreter for venvs.
  signerSubjectCNs: ['Python Software Foundation', 'Microsoft Windows Software Compatibility Publisher'],
  signerSubjectCN: 'Python Software Foundation',
  stripDirs: ['Lib\\site-packages'],
  // Which minor the repaired runtime satisfies — the engine's pin is a minor ("3.11").
  minor: '3.11',
});

// The imports whose native modules the engine needs at boot. `_multiprocessing` is the one
// that broke in the field (uvicorn); the others are the next unsigned .pyd files in line.
const REQUIRED_IMPORTS = Object.freeze(['_multiprocessing', '_ssl', '_socket', 'sqlite3', 'ctypes']);

// ── Detection ────────────────────────────────────────────────────────────────
// What the OS says, through Python, when application control refuses a file. The
// "blocked by …" shapes are the shell's; "Application Control policy" is Code Integrity's.
// Deliberately the same family as uv-manager.js POLICY_BLOCK_TEXT: the panel must not say
// "Smart App Control" — an organization's policy reads identically.
const POLICY_BLOCK_LINE =
  /An Application Control policy has blocked this file|Device Guard|blocked by (your organization|group policy|an administrator|your administrator)|os error 4551/i;

/**
 * Scan backend-server log text for an application-control block. Returns null, or
 * `{ line, module, file, traceback }`: the offending line, the Python module it happened in
 * ("_multiprocessing" from `DLL load failed while importing _multiprocessing`), the last
 * `File "…"` frame before it (the .py that triggered the load), and the traceback block (from
 * the last `Traceback` up to the line) for the panel — the full diagnostics, not a summary.
 */
function detectPolicyBlockInLog(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!POLICY_BLOCK_LINE.test(line)) continue;
    const mod = line.match(/importing ([A-Za-z0-9_.]+)/);
    let file = null;
    let start = i;
    for (let j = i - 1; j >= 0 && i - j < 400; j--) {
      const frame = lines[j].match(/^\s*File "([^"]+)"/);
      if (frame && !file) file = frame[1];
      if (/^Traceback \(most recent call last\)/.test(lines[j])) { start = j; break; }
      if (!file) start = j;
    }
    return {
      line: line.trim(),
      module: mod ? mod[1] : null,
      file,
      traceback: lines.slice(start, i + 1).join('\n'),
    };
  }
  return null;
}

// A server log older than this at probe creation belongs to a previous launch: its content is
// history, not this boot. Each boot writes a fresh, timestamped log file within a second or two
// of the spawn, so anything already a few seconds old when the wait begins is stale.
const STALE_LOG_MS = 5000;

/**
 * A probe over the newest server log for the backend gate: each call answers "does the
 * log show an application-control block?" — the match, or null. Reads the file only when
 * it changed (path or size) since the last call, so polling it every half second is cheap.
 * Primed at construction: the newest file is read only if it is fresh (`fileMtimeMs`
 * within STALE_LOG_MS of `now()`), otherwise it is remembered and skipped until it grows or a
 * newer file appears — the log of a PREVIOUS launch must never decide this one (it would
 * report the old block again before the repaired backend even started).
 * `readTail(path)` returns the last part of the file as text and may throw.
 */
function createPolicyBlockProbe({ newestLogFile, fileSize, readTail, fileMtimeMs = () => 0, now = Date.now }) {
  let seenPath = null;
  let seenSize = -1;
  let last = null;
  try {
    const primed = newestLogFile();
    if (primed && now() - fileMtimeMs(primed.path) > STALE_LOG_MS) {
      seenPath = primed.path;
      seenSize = fileSize(primed.path);
    }
  } catch {
    /* unreadable at priming: treated as absent */
  }
  return function probe() {
    const newest = newestLogFile();
    if (!newest) return null;
    let size;
    try { size = fileSize(newest.path); } catch { return last; }
    if (newest.path === seenPath && size === seenSize) return last;
    seenPath = newest.path;
    seenSize = size;
    try {
      const match = detectPolicyBlockInLog(readTail(newest.path));
      last = match ? { ...match, path: newest.path } : null;
    } catch {
      last = null;
    }
    return last;
  };
}

// ── Persisted state ──────────────────────────────────────────────────────────
// `<stateDir>/desktop-runtime.json`:
//   python     — the interpreter every later `uv tool install --python` must reuse
//   version    — its version ("3.11.9"), source ("python.org"), installedAt (ISO)
//   attempts   — [{ appVersion, engineVersion, at, result }] — ONE repair per app+engine
//                version; a failed one is not retried automatically (no repair loop).
function runtimeStatePath(stateDir) {
  return path.join(stateDir, 'desktop-runtime.json');
}

function readRuntimeState(readFile, stateDir) {
  try {
    const parsed = JSON.parse(readFile(runtimeStatePath(stateDir)));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRuntimeState(writeFile, stateDir, state) {
  writeFile(runtimeStatePath(stateDir), JSON.stringify(state, null, 2));
}

/** The attempt recorded for this app + engine version, or null. */
function priorAttempt(state, { appVersion, engineVersion }) {
  const attempts = (state && Array.isArray(state.attempts)) ? state.attempts : [];
  return attempts.find((a) => a.appVersion === appVersion && a.engineVersion === engineVersion) || null;
}

/** May the app offer the automatic repair? Once per installation/version. */
function canAttemptRepair(state, versions) {
  return priorAttempt(state, versions) === null;
}

function recordAttempt(state, { appVersion, engineVersion, at, result, detail }) {
  const attempts = (state && Array.isArray(state.attempts)) ? state.attempts.slice() : [];
  attempts.push({ appVersion, engineVersion, at, result, ...(detail ? { detail } : {}) });
  return { ...state, attempts };
}

// ── The repair ───────────────────────────────────────────────────────────────
/**
 * Run the repair end to end. `io` supplies every effect:
 *
 *   existingPythonOrgInstall()        → { python } | null — an official 3.11 already on this
 *                                      machine (PEP 514 registry); reused, never reinstalled
 *   download(url, dest, onProgress)   → sha256 of the bytes written (hex, lower case)
 *   extractRuntime(zip, targetDir, manifest) → extracts the archive's `archiveRoot` into targetDir
 *                                      and removes `stripDirs`; rejects on any error
 *   verifyRuntimeSignatures(dir, signers) → { checked, invalid: [{ file, status, subjectCN }] }
 *                                      over every exe/dll/pyd under dir; `invalid` must be empty
 *   validateInterpreter(python, mods) → resolves when `python -c "import …"` exits 0
 *   stageEngine(python)               → installs the engine into a SCRATCH venv on `python` and
 *                                      imports it there; rejects when it does not load. The tool
 *                                      venv is not touched before this passes.
 *   installEngine(python)             → `uv tool install … --python <python> --reinstall --force`
 *   rollbackEngine()                  → put the previous engine back (the environment set aside by
 *                                      installEngine, or a reinstall on the previous pin)
 *   finalizeEngine()                  → optional; the repair held (backend healthy): drop what was
 *                                      set aside
 *   startBackend()                    → start the engine on the new venv
 *   healthCheck()                     → true when the backend answered healthy
 *   remove(pathToRemove)              → best-effort delete (the failed download only)
 *
 * `paths`: { runtimeDir, downloadsDir }. `versions`: { appVersion, engineVersion }.
 * Resolves `{ ok, python, reused, steps }`; rejects with an Error carrying `.step` and
 * `.rolledBack`, after recording the attempt. The user's data, uv's cache and the
 * uv-managed Python are never touched: the failed download is the only thing removed.
 */
async function performRuntimeRepair({
  io,
  paths,
  versions,
  state,
  saveState,
  manifest = PYTHON_RUNTIME_MANIFEST,
  requiredImports = REQUIRED_IMPORTS,
  onProgress = () => {},
  log = console,
  now = () => new Date().toISOString(),
}) {
  if (!canAttemptRepair(state, versions)) {
    const prior = priorAttempt(state, versions);
    const err = new Error(`a runtime repair was already attempted for this version (${prior.at}: ${prior.result})`);
    err.step = 'precheck';
    throw err;
  }
  const steps = [];
  const step = (name, msg) => { steps.push(name); log.info(`[runtime-repair] ${name}: ${msg}`); onProgress(msg); };
  const fail = (name, message, extra = {}) => Object.assign(new Error(message), { step: name, steps, ...extra });

  let python = null;
  let reused = false;
  let engineReplaced = false;
  try {
    // 0. An official 3.11 already here? Use it; never run an installer over an existing one.
    const existing = await io.existingPythonOrgInstall();
    if (existing && existing.python) {
      step('reuse', `found an official Python ${manifest.minor} on this computer: ${existing.python}`);
      await io.validateInterpreter(existing.python, requiredImports).catch((e) => {
        throw fail('validate-existing', `the existing Python ${manifest.minor} cannot load the engine's native modules: ${e.message}`);
      });
      python = existing.python;
      reused = true;
    } else {
      const targetDir = path.join(paths.runtimeDir, `python-${manifest.version}`);
      python = path.join(targetDir, 'python.exe');
      // 1. Download the archive, hashing on the fly.
      const dest = path.join(paths.downloadsDir, manifest.fileName);
      step('download', `downloading the official CPython ${manifest.version} build (Python Software Foundation)`);
      let sha;
      try {
        sha = await io.download(manifest.url, dest, (pct) => onProgress(`downloading CPython ${manifest.version} — ${pct}%`));
      } catch (e) {
        throw fail('download', `could not download ${manifest.url}: ${e.message}`);
      }
      // 2. The manifest's hash. A mismatch is never extracted — the file is removed, the repair stops.
      if (String(sha).toLowerCase() !== manifest.sha256) {
        await io.remove(dest).catch(() => {});
        throw fail('verify-hash', `the downloaded runtime does not match the expected SHA-256 (got ${sha}, expected ${manifest.sha256}); it was deleted`);
      }
      step('verify-hash', 'SHA-256 matches the manifest');
      // 3. Extract into FlowPad's own runtime folder: no installer, no registry, no PATH change,
      //    nothing shared with a Python the user may have. pip/setuptools (unsigned stubs) stripped.
      step('extract', `extracting CPython ${manifest.version} into ${targetDir}`);
      try {
        await io.extractRuntime(dest, targetDir, manifest);
      } catch (e) {
        throw fail('extract', `could not extract the runtime: ${e.message}`, { policyBlocked: !!e.policyBlocked });
      }
      // 4. EVERY executable file of the extracted runtime must carry a Valid signature by an
      //    accepted signer. A signed archive says nothing about its contents; this does.
      const sigs = await io.verifyRuntimeSignatures(targetDir, manifest.signerSubjectCNs);
      if (!sigs || !(sigs.checked > 0) || (sigs.invalid && sigs.invalid.length)) {
        await io.remove(targetDir).catch(() => {});
        const bad = (sigs && sigs.invalid && sigs.invalid.length)
          ? sigs.invalid.slice(0, 5).map((i) => `${i.file}: ${i.status}${i.subjectCN ? ` (${i.subjectCN})` : ''}`).join('; ')
          : 'no files checked';
        throw fail('verify-signatures', `the extracted runtime has unsigned or unexpectedly signed files (${bad}); it was removed`);
      }
      step('verify-signatures', `${sigs.checked} executable files, all Valid and signed by ${manifest.signerSubjectCNs.join(' / ')}`);
    }
    // 4. The interpreter must start and load exactly the modules the engine needs.
    step('validate', `checking the interpreter can load ${requiredImports.join(', ')}`);
    try {
      await io.validateInterpreter(python, requiredImports);
    } catch (e) {
      throw fail('validate', `the installed Python cannot load the engine's native modules: ${e.message}`, { policyBlocked: !!e.policyBlocked });
    }
    // 5. Stage: the engine's own imports on the new interpreter, in a scratch venv that is NOT
    //    the tool venv. The working installation is untouched until this passes — the failure
    //    that started all this (uvicorn → multiprocessing.connection → _multiprocessing) is
    //    reproduced here, against the real packages, before anything is replaced.
    step('stage', 'checking the FlowPad engine imports on the repaired runtime (staging, the current install is untouched)');
    try {
      await io.stageEngine(python);
    } catch (e) {
      throw fail('stage', `the engine does not load on the repaired runtime: ${e.message}`, { policyBlocked: !!e.policyBlocked });
    }
    // 6. Reinstall the engine on it (the previous venv is replaced in place by uv).
    step('install-engine', 'reinstalling the FlowPad engine on the repaired runtime');
    engineReplaced = true;
    try {
      await io.installEngine(python);
    } catch (e) {
      throw fail('install-engine', `reinstalling the engine failed: ${e.message}`);
    }
    // 6. Persist BEFORE starting: a crash during start must not leave the engine on a Python
    //    that the next `uv tool install --python 3.11` would silently swap away again.
    state = { ...state, python, version: manifest.version, source: reused ? 'existing' : 'python.org', installedAt: now() };
    saveState(state);
    // 7. Start and require health.
    step('start', 'starting the FlowPad engine');
    await io.startBackend();
    if (!(await io.healthCheck())) {
      throw fail('health', 'the engine started but never reported healthy');
    }
    state = recordAttempt(state, { ...versions, at: now(), result: 'ok' });
    saveState(state);
    // 8. Healthy: the previous environment (set aside by installEngine) is no longer needed.
    if (io.finalizeEngine) {
      await io.finalizeEngine().catch((e) => log.warn(`[runtime-repair] finalize failed (harmless): ${e.message}`));
    }
    step('done', 'repair complete');
    return { ok: true, python, reused, steps };
  } catch (err) {
    let rolledBack = false;
    if (engineReplaced) {
      // The engine venv was rebuilt on the new Python and something after that failed: put the
      // previous pin back so the next launch is in the state the user had before the repair.
      try {
        log.warn(`[runtime-repair] ${err.step || 'repair'} failed after the engine was replaced — rolling the engine back`);
        onProgress('repair failed — restoring the previous engine');
        await io.rollbackEngine();
        rolledBack = true;
      } catch (rb) {
        log.error(`[runtime-repair] rollback failed: ${rb.message}`);
      }
      state = { ...state };
      delete state.python; delete state.version; delete state.source; delete state.installedAt;
    }
    state = recordAttempt(state, { ...versions, at: now(), result: 'failed', detail: `${err.step}: ${String(err.message).split('\n')[0]}` });
    try { saveState(state); } catch (e) { log.warn(`[runtime-repair] could not record the attempt: ${e.message}`); }
    err.rolledBack = rolledBack;
    err.steps = steps;
    throw err;
  }
}

/** What the panel says for a block found in the server log, and whether it offers Repair. */
function describeRuntimeBlock(match, { repairable, priorFailure }) {
  const where = match.module ? `the Python module "${match.module}"` : 'a Python component';
  const lines = [
    `Windows security blocked a component required by FlowPad: ${where} could not be loaded ` +
      '(Smart App Control or an organization\'s application-control policy decides this per file).',
  ];
  if (repairable) {
    lines.push('FlowPad can attempt to repair its Python runtime without changing Windows security settings: ' +
      'it downloads the official CPython build published by the Python Software Foundation, verifies every file\'s signature, ' +
      'keeps it in FlowPad\'s own folder and reinstalls the engine on it. Click “Repair FlowPad”.');
  } else if (priorFailure) {
    lines.push(`A repair was already attempted for this version (${priorFailure.at}) and ${priorFailure.result === 'ok' ? 'succeeded, but the engine is blocked again' : `failed: ${priorFailure.detail || 'see the logs'}`}. ` +
      'If this computer is managed by an organization, its policy may need IT approval before FlowPad can run; ' +
      'use “Share with us” to send the logs.');
  }
  lines.push('', 'Blocked:', `  ${match.line}`);
  if (match.file) lines.push(`  in ${match.file}`);
  return lines.join('\n');
}

module.exports = {
  PYTHON_RUNTIME_MANIFEST,
  REQUIRED_IMPORTS,
  POLICY_BLOCK_LINE,
  detectPolicyBlockInLog,
  createPolicyBlockProbe,
  runtimeStatePath,
  readRuntimeState,
  writeRuntimeState,
  priorAttempt,
  canAttemptRepair,
  recordAttempt,
  performRuntimeRepair,
  describeRuntimeBlock,
};
